/*
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║         TERMOIGROMETRO ESP8266 — ULTRA LOW-POWER v2.0           ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  MCU      : ESP8266 (ESP-12F / NodeMCU)                         ║
 * ║  Sensore  : SHT40 — I2C su D2 (SDA=4) e D1 (SCL=5)            ║
 * ║  Display  : SSD1306 0.96" OLED — I2C su D5 (SDA=14) e D6(12)  ║
 * ║  Storage  : LittleFS (Flash interna)                             ║
 * ║  REQUISITO HW: collegare GPIO16 (D0) a RST per il wake-up       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 *  ATTIVAZIONE SCHERMO MANUALE: doppio click sul tasto RESET
 *  entro 1.5 secondi dall'avvio (durante la finestra di standby).
 */

// ─── §0  DEBUG ───────────────────────────────────────────────────────────────
// Commentare per build di produzione: Serial OFF → risparmio ~1-2 mA e ~5 ms.
#define DEBUG

#ifdef DEBUG
#define DBG_BEGIN(b)    do { Serial.begin(b); delay(10); } while (0)
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
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <user_interface.h>  // REASON_DEEP_SLEEP_AWAKE

ADC_MODE(ADC_VCC);


// ─── §2  CONFIGURAZIONE ───────────────────────────────────────────────────────
static const char WIFI_SSID[] PROGMEM = "ASUS";
static const char WIFI_PASS[] PROGMEM = "24no1998";
static const char HTTP_EP[]   PROGMEM = "https://dubia-flame.vercel.app/api/ingest";
static const char DATA_FILE[] PROGMEM = "/dati.txt";

static constexpr uint8_t  PIN_SDA_SHT       = 4;     // D2 — SDA SHT40
static constexpr uint8_t  PIN_SCL_SHT       = 5;     // D1 — SCL SHT40
static constexpr uint8_t  PIN_SDA_OLED      = 14;    // D5 — SDA OLED interno
static constexpr uint8_t  PIN_SCL_OLED      = 12;    // D6 — SCL OLED interno
static constexpr uint8_t  DISP_PRI          = 0x3C;
static constexpr uint8_t  DISP_FALL         = 0x3D;
static constexpr uint8_t  SCREEN_W          = 128;
static constexpr uint8_t  SCREEN_H          = 64;
static constexpr uint64_t SLEEP_US          = 60ULL * 1000000ULL;  // 60 secondi (1 minuto)
static constexpr uint32_t READINGS_PER_SEND = 60;                  // Invia ogni 60 misure = 1 ora
static constexpr uint32_t WIFI_TIMEOUT_MS   = 12000UL;
static constexpr uint32_t FS_MAX_BYTES      = 65536UL;
static constexpr uint32_t DISPLAY_WIN_MS    = 2000UL;  // Finestra doppio reset (ms)

// Comandi SSD1306 per spegnimento charge pump
static constexpr uint8_t CMD_CHARGEPUMP = 0x8D;
static constexpr uint8_t CMD_PUMP_OFF   = 0x10;
static constexpr uint8_t CMD_DISPLAYOFF = 0xAE;

// ─── §3  STRUTTURA RTC ────────────────────────────────────────────────────────
// IMPORTANTE: il CRC copre SOLO il campo counter (i 4 byte dopo il CRC stesso).
// Il flag awaiting_double_reset è salvato a indirizzo RTC separato (offset 2)
// per evitare che la sua modifica corrompa il CRC del counter.
struct __attribute__((packed)) RtcCounter {
  uint32_t crc32;
  uint32_t counter;
};
static_assert(sizeof(RtcCounter) <= 8, "RtcCounter troppo grande");
static RtcCounter rtcCounter;

// Flag per il double-reset — salvato all'offset 2 (= 8 byte) della RAM RTC.
// Non coperto dal CRC, quindi può essere modificato liberamente senza rompere nulla.
static constexpr uint8_t  RTC_FLAG_OFFSET = 2;        // in unità di uint32_t
static uint32_t rtcFlagWord = 0;                        // Caricato/scritto separatamente
static constexpr uint32_t MAGIC_AWAIT    = 0xD0B1E55;  // Valore "magic" = aspetta secondo reset

// ─── §4  OGGETTI GLOBALI ──────────────────────────────────────────────────────
static Adafruit_SHT4x   sht4;
static Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);

// =============================================================================
//  UTILITA  CRC
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

// Legge il contatore dalla RAM RTC. Ritorna true se CRC valido.
static bool readRTC() {
  ESP.rtcUserMemoryRead(0, reinterpret_cast<uint32_t *>(&rtcCounter), sizeof(rtcCounter));
  const uint8_t *payload = reinterpret_cast<const uint8_t *>(&rtcCounter.counter);
  return calcCRC32(payload, sizeof(rtcCounter.counter)) == rtcCounter.crc32;
}

// Scrive il contatore nella RAM RTC con CRC aggiornato.
static void writeRTC() {
  const uint8_t *payload = reinterpret_cast<const uint8_t *>(&rtcCounter.counter);
  rtcCounter.crc32 = calcCRC32(payload, sizeof(rtcCounter.counter));
  ESP.rtcUserMemoryWrite(0, reinterpret_cast<uint32_t *>(&rtcCounter), sizeof(rtcCounter));
}

// Legge il flag di double-reset dall'offset 2 della RAM RTC.
static void readRTCFlag() {
  ESP.rtcUserMemoryRead(RTC_FLAG_OFFSET, &rtcFlagWord, sizeof(rtcFlagWord));
}

// Scrive il flag di double-reset.
static void writeRTCFlag(uint32_t value) {
  rtcFlagWord = value;
  ESP.rtcUserMemoryWrite(RTC_FLAG_OFFSET, &rtcFlagWord, sizeof(rtcFlagWord));
}

// Flag per la preparazione della radio (reboot RF_DEFAULT) — offset 3.
static constexpr uint8_t  RTC_RF_OFFSET = 3;          // in unità di uint32_t
static uint32_t rtcRfPrepared = 0;

static void readRTCRfPrepared() {
  ESP.rtcUserMemoryRead(RTC_RF_OFFSET, &rtcRfPrepared, sizeof(rtcRfPrepared));
}

static void writeRTCRfPrepared(uint32_t value) {
  rtcRfPrepared = value;
  ESP.rtcUserMemoryWrite(RTC_RF_OFFSET, &rtcRfPrepared, sizeof(rtcRfPrepared));
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
    DBG_PRINTF("[FS] Dato accodato (file: %u byte)\n", (unsigned)f.size());
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
    DBG_PRINTLN(F("[FS] Nessun dato da inviare"));
    if (f) f.close();
    LittleFS.end(); wifiOff(); return;
  }
  DBG_PRINTF("[WiFi] Invio %u byte di dati...\n", (unsigned)f.size());

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
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
    rtcCounter.counter = 0;
    writeRTC();
    writeRTCRfPrepared(0);
    DBG_PRINTLN(F("[WiFi] OK — file eliminato, counter azzerato"));
  } else {
    DBG_PRINTLN(F("[WiFi] FAIL — dati conservati per prossimo invio"));
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
//  DISPLAY DATI LIVE — Aggiorna ogni secondo per durationMs millisecondi
// =============================================================================
static void runDisplayCycle(uint32_t durationMs = 10000UL) {
  Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
  if (!display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) &&
      !display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
    DBG_PRINTLN(F("[OLED] ERR: init fallita")); return;
  }

  DBG_PRINTF("[OLED] Avvio ciclo display %lu ms\n", durationMs);
  uint32_t t0 = millis();
  while (millis() - t0 < durationMs) {
    int16_t t10 = 0, h10 = 0;
    if (readSensor(t10, h10)) {
      Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
      display.clearDisplay();

      // ── 1. HEADER (Zona Gialla) ──────────────────────────────────
      display.fillRect(0, 0, 128, 16, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
      display.setTextSize(1);
      display.setCursor(22, 4);
      display.print(F("CLIMA AMBIENTE"));

      // Disegna l'icona della batteria (x=110, y=4, w=15, h=8)
      display.drawRect(110, 4, 15, 8, SSD1306_BLACK);
      display.fillRect(125, 6, 2, 4, SSD1306_BLACK);

      uint16_t vcc = ESP.getVcc();
      DBG_PRINTF("[BATTERY] VCC: %u mV\n", vcc);

      uint8_t numBars = 0;
      if (vcc >= 3000) numBars = 4;
      else if (vcc >= 2800) numBars = 3;
      else if (vcc >= 2600) numBars = 2;
      else if (vcc >= 2450) numBars = 1;
      else numBars = 0;

      for (uint8_t i = 0; i < numBars; i++) {
        display.fillRect(112 + (i * 3), 6, 2, 4, SSD1306_BLACK);
      }

      // ── 2. DATI (Zona Azzurra) ──────────────────────────────────
      display.setTextColor(SSD1306_WHITE);

      char tempStr[10];
      char humStr[10];

      if (t10 < 0) {
        sprintf(tempStr, "-%d.%d\xF8" "C", (-t10) / 10, (-t10) % 10);
      } else {
        sprintf(tempStr, "%d.%d\xF8" "C", t10 / 10, t10 % 10);
      }
      sprintf(humStr, "%d.%d%% RH", h10 / 10, h10 % 10);

      // Temperatura (centrata)
      display.setTextSize(3);
      int tempWidth = strlen(tempStr) * 18;
      display.setCursor((128 - tempWidth) / 2, 22);
      display.print(tempStr);

      // Umidita (centrata)
      display.setTextSize(2);
      int humWidth = strlen(humStr) * 12;
      display.setCursor((128 - humWidth) / 2, 48);
      display.print(humStr);

      display.display();
    }

    uint32_t delayStart = millis();
    while (millis() - delayStart < 1000UL) {
      yield();
    }
  }

  // Spegni lo schermo alla fine del ciclo
  display.ssd1306_command(CMD_CHARGEPUMP);
  display.ssd1306_command(CMD_PUMP_OFF);
  display.ssd1306_command(CMD_DISPLAYOFF);
  DBG_PRINTLN(F("[OLED] Display spento — standby"));
}

// =============================================================================
//  SETUP E LOOP
// =============================================================================
void setup() {
  WiFi.mode(WIFI_OFF);
  WiFi.forceSleepBegin();

  DBG_BEGIN(115200);
  DBG_PRINTLN(F("\n[BOOT] Termoigrometro ESP8266 v2.0"));
#ifdef DEBUG
  scanI2C();
#endif

  // ── Leggi contatore dalla RAM RTC ────────────────────────────────────────
  if (!readRTC()) {
    // CRC non valido = primo avvio o reset HW totale
    DBG_PRINTLN(F("[RTC] CRC invalido — primo avvio, contatore azzerato"));
    rtcCounter.counter = 0;
    writeRTC();
  }
  // Sanity check: evita overflow anomalo
  if (rtcCounter.counter > 10000u) rtcCounter.counter = READINGS_PER_SEND;
  DBG_PRINTF("[RTC] Contatore: %lu / %u\n", rtcCounter.counter, READINGS_PER_SEND);

  // ── Leggi flag dalla RAM RTC ───────────────────────────
  readRTCFlag();
  readRTCRfPrepared();

  const bool autoWake = isDeepSleepWake();
  if (!autoWake && rtcRfPrepared != 0) {
    writeRTCRfPrepared(0);
  }
  DBG_PRINTF("[BOOT] Modalita: %s | SDK: %s\n",
             autoWake ? "AUTO" : "MANUALE", ESP.getResetReason().c_str());

  // ── Rilevamento double-reset ─────────────────────────────────────────────
  // Se il flag e' MAGIC_AWAIT, significa che al boot precedente (AUTO) abbiamo
  // aperto la finestra di attesa e l'utente ha premuto RESET → attiva display.
  bool manualOverride = false;
  if (rtcFlagWord == MAGIC_AWAIT) {
    DBG_PRINTLN(F("[BOOT] *** Double-Reset rilevato! Attivo display 10s ***"));
    manualOverride = true;
    writeRTCFlag(0);  // Cancella subito il flag
  }

  // ── Lettura sensore ───────────────────────────────────────────────────────
  int16_t t10, h10;
  if (!readSensor(t10, h10)) {
    DBG_PRINTLN(F("[ERR] Sensore — mostro errore su display, poi sleep 60s"));
    writeRTCFlag(0);  // Resetta flag in caso di errore
    showError();
    ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED);
    return;
  }

  // ── Logica Principale ─────────────────────────────────────────────────────
  if (!manualOverride) {
    if (autoWake) {
      // 1. Apri la finestra per il doppio reset PRIMA di salvare.
      // Se l'utente preme reset ora, il riavvio annulla il salvataggio!
      writeRTCFlag(MAGIC_AWAIT);
      DBG_PRINTF("[BOOT] Finestra double-reset aperta (%lu ms)...\n", DISPLAY_WIN_MS);

      const uint32_t t_win = millis();
      while (millis() - t_win < DISPLAY_WIN_MS) {
        yield();
      }

      // Nessun reset ricevuto: cancella il flag
      writeRTCFlag(0);
      DBG_PRINTLN(F("[BOOT] Finestra chiusa senza reset."));
    }

    // 2. Salva misurazione e aggiorna contatore (non era un double-reset)
    saveMeasurement(t10, h10);
    ++rtcCounter.counter;
    writeRTC();
    DBG_PRINTF("[RTC] Aggiornato: %lu\n", rtcCounter.counter);

    if (autoWake) {
      // 3a. Avvio automatico da timer: controllo invio Wi-Fi
      if (rtcCounter.counter >= READINGS_PER_SEND) {
        if (rtcRfPrepared == 1) {
          DBG_PRINTLN(F("[AUTO] Radio calibrata — avvio trasmissione Wi-Fi"));
          writeRTCRfPrepared(0); // Resetta subito il flag
          WiFi.forceSleepWake();
          delay(1);
          sendWiFiData();
        } else {
          DBG_PRINTLN(F("[AUTO] Soglia raggiunta — riavvio rapido con RF_DEFAULT per calibrazione..."));
          writeRTCRfPrepared(1);
          // Riavvio rapido (10ms) per riaccendere ed eseguire la calibrazione RF prima dell'invio
          ESP.deepSleep(10000ULL, WAKE_RF_DEFAULT);
          return;
        }
      } else {
        if (rtcRfPrepared != 0) {
          writeRTCRfPrepared(0);
        }
        DBG_PRINTF("[AUTO] %lu/%u — sleep RF_OFF\n", rtcCounter.counter, READINGS_PER_SEND);
      }
    } else {
      // 3b. Avvio manuale a freddo (USB o power-on): mostra schermo 10s
      DBG_PRINTLN(F("[MAN] Avvio a freddo — Ciclo Display 10s"));
      runDisplayCycle(10000UL);

      // Forza la trasmissione immediata dei dati dopo il display
      DBG_PRINTLN(F("[MAN] Invio dati immediato post-display..."));
      WiFi.forceSleepWake();
      delay(1);
      sendWiFiData();
    }
  } else {
    // DOUBLE-RESET (manualOverride == true)
    DBG_PRINTLN(F("[RTC] Double-Reset: saltato salvataggio per evitare letture fittizie (timeline sfasata)"));

    // Mostra schermo 10 secondi
    DBG_PRINTLN(F("[MAN] Ciclo Display 10s (double-reset)"));
    runDisplayCycle(10000UL);

    // Forza la trasmissione immediata dei dati dopo il display
    DBG_PRINTLN(F("[MAN] Invio dati immediato post-display..."));
    WiFi.forceSleepWake();
    delay(1);
    sendWiFiData();
  }

  uint32_t elapsedMs = millis();
  uint32_t sleepMs = SLEEP_US / 1000ULL;
  uint64_t actualSleepUs;
  if (elapsedMs < sleepMs) {
    actualSleepUs = (sleepMs - elapsedMs) * 1000ULL;
  } else {
    actualSleepUs = 1000000ULL; // Minimo 1 secondo
  }

  DBG_PRINTF("[BOOT] → deepSleep %llu s (sveglio per %lu ms)\n", actualSleepUs / 1000000ULL, elapsedMs);
  ESP.deepSleep(actualSleepUs, WAKE_RF_DISABLED);
}

void loop() { ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED); }
