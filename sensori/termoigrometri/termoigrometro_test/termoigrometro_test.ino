/*
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║         TERMOIGROMETRO ESP8266 — VERSIONE TEST VELOCE            ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  MCU      : ESP8266 (ESP-12F / NodeMCU)                         ║
 * ║  Sensore  : SHT40 — I2C su GPIO14 (SCL/D5) e GPIO12 (SDA/D6)  ║
 * ║  Display  : SSD1306 0.96" OLED — fallback addr 0x3C → 0x3D     ║
 * ║  Storage  : LittleFS (Flash interna)                             ║
 * ║  REQUISITO HW: collegare GPIO16 (D0) a RST per il wake-up       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ─── §0  DEBUG ───────────────────────────────────────────────────────────────
// Commentare per build di produzione: Serial OFF → risparmio ~1-2 mA e ~5 ms.
#define DEBUG

#ifdef DEBUG
#define DBG_BEGIN(b)    do { Serial.begin(b); delay(10); } while (0) // 10 ms basta per UART FIFO
#define DBG_PRINT(x)    Serial.print(x)
#define DBG_PRINTLN(x)  Serial.println(x)
#define DBG_PRINTF(...) Serial.printf(__VA_ARGS__)
#else
#define DBG_BEGIN(b)
#define DBG_PRINT(x)
#define DBG_PRINTLN(x)
#define DBG_PRINTF(...)
#endif

// ─── §1  LIBRERIE ─────────────────────────────────────────────────────────────
#include <Adafruit_GFX.h>
#include <Adafruit_SHT4x.h>
#include <Adafruit_SSD1306.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#include <LittleFS.h>
#include <WiFiClient.h>
#include <Wire.h>
#include <user_interface.h>  // REASON_DEEP_SLEEP_AWAKE

// ─── §2  CONFIGURAZIONE ───────────────────────────────────────────────────────
static const char WIFI_SSID[] PROGMEM = "ASUS";
static const char WIFI_PASS[] PROGMEM = "24no1998";
static const char HTTP_EP[]   PROGMEM = "https://dubia-flame.vercel.app/api/ingest"; // Endpoint Vercel corretto
static const char DATA_FILE[] PROGMEM = "/dati.txt";

static constexpr uint8_t  PIN_SDA_SHT       = 4;     // D2 — Filo Verde Sensore SHT40
static constexpr uint8_t  PIN_SCL_SHT       = 5;     // D1 — Filo Giallo Sensore SHT40
static constexpr uint8_t  PIN_SDA_OLED      = 14;    // D5 — SDA interno schermo OLED
static constexpr uint8_t  PIN_SCL_OLED      = 12;    // D6 — SCL interno schermo OLED
static constexpr uint8_t  DISP_PRI          = 0x3C;
static constexpr uint8_t  DISP_FALL         = 0x3D;
static constexpr uint8_t  SCREEN_W          = 128;
static constexpr uint8_t  SCREEN_H          = 64;
static constexpr uint64_t SLEEP_US          = 5ULL * 1000000ULL; // 5 secondi di pausa
static constexpr uint32_t READINGS_PER_SEND = 12; // 12 letture da 5 secondi = 60 secondi
static constexpr uint32_t WIFI_TIMEOUT_MS   = 10000UL;
static constexpr uint32_t DISP_TIMEOUT_MS   = 90000UL;
static constexpr uint32_t FS_MAX_BYTES      = 65536UL; // guard LittleFS overflow

// Comandi SSD1306 per spegnimento charge pump
static constexpr uint8_t CMD_CHARGEPUMP = 0x8D;
static constexpr uint8_t CMD_PUMP_OFF   = 0x10;
static constexpr uint8_t CMD_DISPLAYOFF = 0xAE;

// ─── §3  STRUTTURA RTC ────────────────────────────────────────────────────────
struct __attribute__((packed)) RtcData {
  uint32_t crc32;
  uint32_t counter;
};
static_assert(sizeof(RtcData) <= 512, "RtcData supera i 512 B di RAM RTC");
static RtcData rtcData;

// ─── §4  OGGETTI GLOBALI ──────────────────────────────────────────────────────
static Adafruit_SHT4x   sht4;
static Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);

// =============================================================================
//  UTILITA
// =============================================================================

static uint32_t calcCRC32(const uint8_t *d, size_t n) {
  uint32_t crc = 0xFFFFFFFFu;
  while (n--) {
    uint8_t b = *d++;
    for (uint8_t i = 8; i; --i, b >>= 1)
      crc = ((crc ^ b) & 1u) ? (crc >> 1) ^ 0xEDB88320u : (crc >> 1);
  }
  return ~crc;
}

static inline const uint8_t *rtcPayload() {
  return reinterpret_cast<const uint8_t *>(&rtcData) + sizeof(rtcData.crc32);
}
static constexpr size_t RTC_PAYLOAD_LEN = sizeof(RtcData) - sizeof(uint32_t);

static bool readRTC() {
  ESP.rtcUserMemoryRead(0, reinterpret_cast<uint32_t *>(&rtcData), sizeof(rtcData));
  return calcCRC32(rtcPayload(), RTC_PAYLOAD_LEN) == rtcData.crc32;
}

static void writeRTC() {
  rtcData.crc32 = calcCRC32(rtcPayload(), RTC_PAYLOAD_LEN);
  ESP.rtcUserMemoryWrite(0, reinterpret_cast<uint32_t *>(&rtcData), sizeof(rtcData));
}

static inline bool isDeepSleepWake() {
  return ESP.getResetInfoPtr()->reason == REASON_DEEP_SLEEP_AWAKE;
}

static inline void wifiOff() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
}

// =============================================================================
//  DIAGNOSTICA I2C
// =============================================================================
#ifdef DEBUG
static void scanI2C() {
  const uint8_t pairs[][2] = {
    {4,  5},
    {12, 14},
    {0,  2},
  };
  const char *names[] = { "D2(SDA)/D1(SCL)", "D6(SDA)/D5(SCL)", "D3(SDA)/D4(SCL)" };

  DBG_PRINTLN(F("\n[I2C SCAN] Ricerca dispositivi su pin comuni NodeMCU..."));
  bool found = false;
  for (uint8_t p = 0; p < 3; p++) {
    Wire.begin(pairs[p][0], pairs[p][1]);
    for (uint8_t addr = 1; addr < 127; addr++) {
      Wire.beginTransmission(addr);
      if (Wire.endTransmission() == 0) {
        DBG_PRINTF("  >> Dispositivo 0x%02X su pin %s\n", addr, names[p]);
        found = true;
      }
      yield();
    }
  }
  if (!found) DBG_PRINTLN(F("  >> Nessun dispositivo I2C trovato!"));
  DBG_PRINTLN(F("[I2C SCAN] Fine.\n"));

  Wire.begin(PIN_SDA_SHT, PIN_SCL_SHT);
}
#endif

// =============================================================================
//  LETTURA SENSORE SHT40
// =============================================================================
static bool readSensor(int16_t &t10, int16_t &h10) {
  Wire.begin(PIN_SDA_SHT, PIN_SCL_SHT);
  if (!sht4.begin(&Wire)) { DBG_PRINTLN(F("[SHT40] ERR: init")); return false; }
  sht4.setPrecision(SHT4X_HIGH_PRECISION);
  sht4.setHeater(SHT4X_NO_HEATER);

  sensors_event_t hEv, tEv;
  if (!sht4.getEvent(&hEv, &tEv)) { DBG_PRINTLN(F("[SHT40] ERR: lettura")); return false; }

  if (tEv.temperature < -40.0f || tEv.temperature > 125.0f ||
      hEv.relative_humidity < 0.0f || hEv.relative_humidity > 100.0f) {
    DBG_PRINTLN(F("[SHT40] ERR: fuori range")); return false;
  }

  t10 = static_cast<int16_t>(tEv.temperature      * 10.0f + 0.5f);
  h10 = static_cast<int16_t>(hEv.relative_humidity * 10.0f + 0.5f);
  DBG_PRINTF("[SHT40] T=%d.%d C  H=%d.%d%%\n", t10/10, t10%10, h10/10, h10%10);
  return true;
}

// =============================================================================
//  DATA LOGGING SU LITTLEFS
// =============================================================================
static void saveMeasurement(int16_t t10, int16_t h10) {
  if (!LittleFS.begin()) { DBG_PRINTLN(F("[FS] ERR: mount")); return; }
  File f = LittleFS.open(FPSTR(DATA_FILE), "a");
  if (!f) { DBG_PRINTLN(F("[FS] ERR: open")); LittleFS.end(); return; }

  if (f.size() < FS_MAX_BYTES) {
    f.print(t10); f.print(','); f.println(h10);
    DBG_PRINTLN(F("[FS] Dato accodato"));
  } else {
    DBG_PRINTLN(F("[FS] WARN: file pieno, dato scartato"));
  }
  f.close();
  LittleFS.end();
}

// =============================================================================
//  TRASMISSIONE WI-FI
// =============================================================================
static void sendWiFiData() {
  DBG_PRINTLN(F("[WiFi] Connessione..."));
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.begin(FPSTR(WIFI_SSID), FPSTR(WIFI_PASS));

  const uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - t0 >= WIFI_TIMEOUT_MS) {
      DBG_PRINTLN(F("[WiFi] Timeout — dati preservati"));
      wifiOff(); return;
    }
    yield();
  }
  DBG_PRINTF("[WiFi] Connesso in %lu ms\n", millis() - t0);

  if (!LittleFS.begin()) { DBG_PRINTLN(F("[FS] ERR: mount per invio")); wifiOff(); return; }

  File f = LittleFS.open(FPSTR(DATA_FILE), "r");
  if (!f || f.size() == 0) {
    DBG_PRINTLN(F("[FS] Nessun dato"));
    if (f) f.close();
    LittleFS.end(); wifiOff(); return;
  }

  WiFiClient client;
  HTTPClient  http;
  bool sendOk = false;

  if (http.begin(client, FPSTR(HTTP_EP))) {
    http.addHeader(F("Content-Type"), F("text/csv"));
    http.addHeader(F("X-Device-ID"), WiFi.macAddress());
    http.setTimeout(8000);
    const int code = http.sendRequest("POST", &f, f.size());
    DBG_PRINTF("[HTTP] Risposta: %d\n", code);
    sendOk = (code >= 200 && code < 300);
    http.end();
  } else {
    DBG_PRINTLN(F("[HTTP] ERR: begin()"));
  }

  f.close();
  LittleFS.end();

  if (sendOk) {
    LittleFS.begin();
    LittleFS.remove(FPSTR(DATA_FILE));
    LittleFS.end();
    rtcData.counter = 0;
    writeRTC();
    DBG_PRINTLN(F("[WiFi] OK — file eliminato"));
  } else {
    DBG_PRINTLN(F("[WiFi] FAIL — dati conservati"));
  }

  wifiOff();
}

// =============================================================================
//  DISPLAY ERRORE DESCRITTIVO
// =============================================================================
static void showError() {
  Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);

  if (!display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) &&
      !display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
    DBG_PRINTLN(F("[OLED] ERR: display non trovato")); return;
  }
  delay(10);

  display.clearDisplay();

  display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(22, 3);
  display.print(F("[  ERRORE  ]"));

  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(34, 18);
  display.print(F("SONDA"));
  display.setCursor(16, 36);
  display.print(F("MANCANTE"));

  display.display();
  DBG_PRINTLN(F("[OLED] Errore: SONDA MANCANTE"));

  for (uint8_t i = 0; i < 3; i++) {
    display.invertDisplay(true);
    const uint32_t t1 = millis(); while (millis() - t1 < 180UL) yield();
    display.invertDisplay(false);
    const uint32_t t2 = millis(); while (millis() - t2 < 250UL) yield();
  }

  const uint32_t tf = millis(); while (millis() - tf < 3500UL) yield();

  display.ssd1306_command(CMD_CHARGEPUMP);
  display.ssd1306_command(CMD_PUMP_OFF);
  display.ssd1306_command(CMD_DISPLAYOFF);
  DBG_PRINTLN(F("[OLED] Display spento — charge pump OFF"));
}

// =============================================================================
//  DISPLAY UX DESIGN — Ottimizzato per OLED Bicolore (16px Gialli / 48px Azzurri)
// =============================================================================
static void showDisplay(int16_t t10, int16_t h10) {
  Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
  if (!display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) &&
      !display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
    DBG_PRINTLN(F("[OLED] ERR: init fallita")); return;
  }

  display.clearDisplay();

  // ── 1. HEADER (Zona Gialla: y = 0 a 15) ──────────────────────────────────
  display.fillRect(0, 0, 128, 16, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1); // Testo 6x8 px
  display.setCursor(22, 4); // y=4 per centrare verticalmente nei 16px
  display.print(F("CLIMA AMBIENTE"));

  // ── 2. DATI (Zona Azzurra: y = 16 a 63) ──────────────────────────────────
  display.setTextColor(SSD1306_WHITE);

  char tempStr[10];
  char humStr[10];

  if (t10 < 0) {
    sprintf(tempStr, "-%d.%d\xF8" "C", (-t10) / 10, (-t10) % 10);
  } else {
    sprintf(tempStr, "%d.%d\xF8" "C", t10 / 10, t10 % 10);
  }
  
  sprintf(humStr, "%d.%d%% RH", h10 / 10, h10 % 10);

  // Temperatura
  display.setTextSize(3);
  int tempLen = strlen(tempStr);
  int tempWidth = tempLen * 18; 
  int tempX = (128 - tempWidth) / 2;
  display.setCursor(tempX, 22);
  display.print(tempStr);

  // Umidita
  display.setTextSize(2);
  int humLen = strlen(humStr);
  int humWidth = humLen * 12; 
  int humX = (128 - humWidth) / 2;
  display.setCursor(humX, 48);
  display.print(humStr);

  display.display();
  DBG_PRINTLN(F("[OLED] Attendo 90 s"));

  const uint32_t t0 = millis();
  while (millis() - t0 < DISP_TIMEOUT_MS) yield();

  display.ssd1306_command(CMD_CHARGEPUMP);
  display.ssd1306_command(CMD_PUMP_OFF);
  display.ssd1306_command(CMD_DISPLAYOFF);
  DBG_PRINTLN(F("[OLED] Charge pump OFF"));
}

// =============================================================================
//  SETUP E LOOP
// =============================================================================
void setup() {
  WiFi.mode(WIFI_OFF);
  WiFi.forceSleepBegin();

  DBG_BEGIN(115200);
  DBG_PRINTLN(F("\n[BOOT] Termoigrometro ESP8266 v2.0 - FAST TEST"));
#ifdef DEBUG
  scanI2C();
#endif

  if (!readRTC()) {
    DBG_PRINTLN(F("[RTC] CRC invalido — reset contatore"));
    rtcData.counter = 0;
    writeRTC();
  }
  if (rtcData.counter > READINGS_PER_SEND * 2u) rtcData.counter = READINGS_PER_SEND;
  DBG_PRINTF("[RTC] Contatore: %lu / %u\n", rtcData.counter, READINGS_PER_SEND);

  const bool autoWake = isDeepSleepWake();
  DBG_PRINTF("[BOOT] Modalita: %s | SDK: %s\n",
             autoWake ? "AUTO" : "MANUALE", ESP.getResetReason().c_str());

  int16_t t10, h10;
  if (!readSensor(t10, h10)) {
    DBG_PRINTLN(F("[ERR] Sensore — mostro errore su display, poi sleep 5s"));
    showError();
    ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED);
    return;
  }

  saveMeasurement(t10, h10);
  ++rtcData.counter;
  writeRTC();
  DBG_PRINTF("[RTC] Aggiornato: %lu\n", rtcData.counter);

  if (autoWake) {
    if (rtcData.counter >= READINGS_PER_SEND) {
      DBG_PRINTLN(F("[AUTO] Soglia — trasmissione Wi-Fi"));
      WiFi.forceSleepWake();
      delay(1);
      sendWiFiData();
    } else {
      DBG_PRINTF("[AUTO] %lu/%u — sleep RF_OFF\n", rtcData.counter, READINGS_PER_SEND);
    }
  } else {
    DBG_PRINTLN(F("[MAN] Display 90s"));
    showDisplay(t10, h10);
  }

  DBG_PRINTLN(F("[BOOT] → deepSleep 5s"));
  ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED);
}

void loop() { ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED); }
