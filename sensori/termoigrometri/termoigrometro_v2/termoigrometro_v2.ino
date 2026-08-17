/*
 * +------------------------------------------------------------------+
 *    TERMOIGROMETRO ESP8266  VERSIONE PRODUZIONE v2.0             
 * ------------------------------------------------------------------
 *   MCU      : ESP8266 (ESP-12F / NodeMCU)                         
 *   Sensore  : SHT40 via I2C (SDA=D2/GPIO4, SCL=D1/GPIO5)         
 *   Display  : SSD1306 0.96" OLED  I2C su D5 (SDA=14) e D6(12)  
 *   Storage  : LittleFS (Flash interna)                             
 *   REQUISITO HW: collegare GPIO16 (D0) a RST per il wake-up       
 * +------------------------------------------------------------------+
 *
 *  ATTIVAZIONE SCHERMO MANUALE: doppio click sul tasto RESET
 *  entro 1.5 secondi dall'avvio (durante la finestra di standby).
 *
 *  MENU TASTO FLASH (GPIO0 / D3):
 *   - Hold 5s  -> Rilascia: menu impostazione intervallo sleep
 *                 (click corto per ciclare tra 5/15/30/60 min, attesa 5s salva)
 *   - Hold 10s -> Rilascia: avvio portale WiFi diretto
 *
 *  OTTIMIZZAZIONE IRAM:
 *   - Le funzioni lente (WiFi, display, FS) sono marcate FLASH_FN
 *     e risiedono in Flash (IROM), non in IRAM.
 *   - #define DEBUG e' commentato in produzione (meno codice Serial).
 */

// --- 0  DEBUG ---
// Decommentare la riga seguente SOLO per debug (aumenta IRAM ~8%).
// In produzione tenerla commentata per massimizzare la memoria libera.
// #define DEBUG

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

// --- 0b  OTTIMIZZAZIONE IRAM ---
// Funzioni marcate FLASH_FN risiedono in Flash (IROM) invece che in IRAM.
// NON applicare a funzioni chiamate da ISR o codice time-critical.
#define FLASH_FN __attribute__((section(".irom0.text"), noinline))

// --- 1  LIBRERIE ---
#include <Adafruit_GFX.h>
#include <Adafruit_SHT4x.h>
#include <Adafruit_SSD1306.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#include <LittleFS.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <user_interface.h>
#include <DNSServer.h>
#include <ESP8266WebServer.h>

// --- 2  CONFIGURAZIONE ---
static const char WIFI_SSID[]   PROGMEM = "ASUS";
static const char WIFI_PASS[]   PROGMEM = "24no1998";
static const char HTTP_EP[]     PROGMEM = "https://okopipo-junglelab-vg32.vercel.app/api/ingest";
static const char DATA_FILE[]   PROGMEM = "/dati.txt";
static const char CONFIG_FILE[] PROGMEM = "/config.txt";

static String wifiSsid;
static String wifiPass;
static String httpEndpoint;

static uint8_t sdaPinSht = 4;
static uint8_t sclPinSht = 5;
static bool sensorPinsDetected = false;
static constexpr uint8_t  PIN_SDA_OLED = 14;
static constexpr uint8_t  PIN_SCL_OLED = 12;
static constexpr uint8_t  DISP_PRI     = 0x3C;
static constexpr uint8_t  DISP_FALL    = 0x3D;
static constexpr uint8_t  SCREEN_W     = 128;
static constexpr uint8_t  SCREEN_H     = 64;
static constexpr uint8_t  PIN_FLASH    = 0;    // GPIO0 = Tasto FLASH fisico

// --- PARAMETRI DI PRODUZIONE (Valori di Default) ---
// SLEEP_US e READINGS_PER_SEND sono ora variabili dinamiche caricate da LittleFS.
// Possono essere modificate dall'utente tramite il menu del tasto FLASH.
static constexpr uint64_t SLEEP_US_DEFAULT          = 15ULL * 60ULL * 1000000ULL;  // 15 minuti (default)
static constexpr uint32_t READINGS_PER_SEND_DEFAULT = 12;                           // Invia ogni 3 ore (default)
static uint64_t sleepUs          = SLEEP_US_DEFAULT;
static uint32_t readingsPerSend  = READINGS_PER_SEND_DEFAULT;

// Valori selezionabili tramite menu (minuti, moltiplicatori invio corrispondenti)
// Opzioni: 5 min (x12 = 1h), 15 min (x12 = 3h), 30 min (x6 = 3h), 60 min (x3 = 3h)
static const uint32_t SLEEP_OPTIONS_MIN[]          = { 5, 15, 30, 60 };
static const uint32_t READINGS_OPTIONS[]            = { 12, 12,  6,  3 };
static constexpr uint8_t NUM_SLEEP_OPTIONS          = 4;

static constexpr uint32_t WIFI_TIMEOUT_MS   = 12000UL;
static constexpr uint32_t FS_MAX_BYTES      = 65536UL;
static constexpr uint32_t DISPLAY_WIN_MS    = 2000UL;

static constexpr uint8_t CMD_CHARGEPUMP = 0x8D;
static constexpr uint8_t CMD_PUMP_OFF   = 0x10;
static constexpr uint8_t CMD_DISPLAYOFF = 0xAE;

// --- 3  STRUTTURA RTC ---
struct __attribute__((packed)) RtcCounter {
  uint32_t crc32;
  uint32_t counter;
};
static_assert(sizeof(RtcCounter) <= 8, "RtcCounter troppo grande");
static RtcCounter rtcCounter;

static constexpr uint8_t  RTC_FLAG_OFFSET     = 2;
static uint32_t           rtcFlagWord          = 0;
static constexpr uint32_t MAGIC_AWAIT          = 0xD0B1E55;
static constexpr uint32_t MAGIC_CONFIG_PORTAL  = 0xC0DF16;
static constexpr uint32_t MAGIC_CONFIG_CONFIRM = 0xC0DF0B;

struct __attribute__((packed)) RtcWifiCache {
  uint32_t crc32;
  uint8_t  channel;
  uint8_t  bssid[6];
  uint8_t  padding;
};
static_assert(sizeof(RtcWifiCache) == 12, "RtcWifiCache deve essere di 12 byte");
static RtcWifiCache rtcWifi;

static constexpr uint8_t RTC_WIFI_OFFSET = 4;
static constexpr uint8_t RTC_RF_OFFSET   = 3;

static_assert(RTC_FLAG_OFFSET * 4u >= sizeof(RtcCounter),  "RTC Flag sovrapposto a RtcCounter!");
static_assert(RTC_RF_OFFSET * 4u >= (RTC_FLAG_OFFSET * 4u + 4u), "RTC RF sovrapposto a Flag!");
static_assert(RTC_WIFI_OFFSET * 4u >= (RTC_RF_OFFSET * 4u + 4u), "RTC WiFi sovrapposto a RF!");

// ─── §4  OGGETTI GLOBALI ──────────────────────────────────────────────────────
static Adafruit_SHT4x      sht4;
static Adafruit_SSD1306    display(SCREEN_W, SCREEN_H, &Wire, -1);

// =============================================================================
//  CRC
// =============================================================================
static FLASH_FN uint32_t calcCRC32(const uint8_t *d, size_t n) {
  uint32_t crc = 0xFFFFFFFFu;
  while (n--) {
    uint8_t b = *d++;
    for (uint8_t i = 8; i; --i, b >>= 1)
      crc = ((crc ^ b) & 1u) ? (crc >> 1) ^ 0xEDB88320u : (crc >> 1);
  }
  return ~crc;
}

static FLASH_FN bool readRTC() {
  ESP.rtcUserMemoryRead(0, reinterpret_cast<uint32_t *>(&rtcCounter), sizeof(rtcCounter));
  const uint8_t *p = reinterpret_cast<const uint8_t *>(&rtcCounter.counter);
  return calcCRC32(p, sizeof(rtcCounter.counter)) == rtcCounter.crc32;
}

static FLASH_FN void writeRTC() {
  const uint8_t *p = reinterpret_cast<const uint8_t *>(&rtcCounter.counter);
  rtcCounter.crc32 = calcCRC32(p, sizeof(rtcCounter.counter));
  ESP.rtcUserMemoryWrite(0, reinterpret_cast<uint32_t *>(&rtcCounter), sizeof(rtcCounter));
}

static void readRTCFlag()            { ESP.rtcUserMemoryRead(RTC_FLAG_OFFSET, &rtcFlagWord, sizeof(rtcFlagWord)); }
static void writeRTCFlag(uint32_t v) { rtcFlagWord = v; ESP.rtcUserMemoryWrite(RTC_FLAG_OFFSET, &rtcFlagWord, sizeof(rtcFlagWord)); }

static uint32_t rtcRfPrepared = 0;
static void readRTCRfPrepared()            { ESP.rtcUserMemoryRead(RTC_RF_OFFSET, &rtcRfPrepared, sizeof(rtcRfPrepared)); }
static void writeRTCRfPrepared(uint32_t v) { rtcRfPrepared = v; ESP.rtcUserMemoryWrite(RTC_RF_OFFSET, &rtcRfPrepared, sizeof(rtcRfPrepared)); }

static FLASH_FN bool readRTCWifi() {
  ESP.rtcUserMemoryRead(RTC_WIFI_OFFSET, reinterpret_cast<uint32_t *>(&rtcWifi), sizeof(rtcWifi));
  const uint8_t *p = reinterpret_cast<const uint8_t *>(&rtcWifi.channel);
  return calcCRC32(p, sizeof(rtcWifi) - sizeof(rtcWifi.crc32)) == rtcWifi.crc32;
}

static FLASH_FN void writeRTCWifi() {
  const uint8_t *p = reinterpret_cast<const uint8_t *>(&rtcWifi.channel);
  rtcWifi.crc32 = calcCRC32(p, sizeof(rtcWifi) - sizeof(rtcWifi.crc32));
  ESP.rtcUserMemoryWrite(RTC_WIFI_OFFSET, reinterpret_cast<uint32_t *>(&rtcWifi), sizeof(rtcWifi));
}

static FLASH_FN void recoverI2C(uint8_t sdaPin, uint8_t sclPin) {
  pinMode(sdaPin, INPUT_PULLUP);
  pinMode(sclPin, OUTPUT);
  if (digitalRead(sdaPin) == HIGH) { pinMode(sdaPin, INPUT); pinMode(sclPin, INPUT); return; }
  for (uint8_t i = 0; i < 9; i++) {
    digitalWrite(sclPin, LOW); delayMicroseconds(5);
    digitalWrite(sclPin, HIGH); delayMicroseconds(5);
    if (digitalRead(sdaPin) == HIGH) break;
  }
  pinMode(sdaPin, OUTPUT);
  digitalWrite(sdaPin, LOW); delayMicroseconds(5);
  digitalWrite(sclPin, HIGH); delayMicroseconds(5);
  digitalWrite(sdaPin, HIGH); delayMicroseconds(5);
  pinMode(sdaPin, INPUT); pinMode(sclPin, INPUT);
}

static FLASH_FN void loadConfig() {
  wifiSsid = FPSTR(WIFI_SSID); wifiPass = FPSTR(WIFI_PASS); httpEndpoint = FPSTR(HTTP_EP);
  sleepUs = SLEEP_US_DEFAULT; readingsPerSend = READINGS_PER_SEND_DEFAULT;
  if (LittleFS.begin()) {
    if (LittleFS.exists(FPSTR(CONFIG_FILE))) {
      File f = LittleFS.open(FPSTR(CONFIG_FILE), "r");
      if (f) {
        String s = f.readStringUntil('\n'); s.trim();
        String p = f.readStringUntil('\n'); p.trim();
        String e = f.readStringUntil('\n'); e.trim();
        String slMin = f.readStringUntil('\n'); slMin.trim(); // Riga 4: minuti di sleep
        String sendRds = f.readStringUntil('\n'); sendRds.trim(); // Riga 5: invio ogni X letture
        f.close();
        if (s.length() > 0 && e.length() > 0) { wifiSsid = s; wifiPass = p; httpEndpoint = e; DBG_PRINTLN(F("[CONF] Config caricata da file.")); }
        if (slMin.length() > 0) {
          uint32_t slMinVal = (uint32_t)slMin.toInt();
          // Cerca l'opzione corrispondente
          for (uint8_t i = 0; i < NUM_SLEEP_OPTIONS; i++) {
            if (SLEEP_OPTIONS_MIN[i] == slMinVal) {
              sleepUs = (uint64_t)slMinVal * 60ULL * 1000000ULL;
              break;
            }
          }
        }
        if (sendRds.length() > 0) {
          readingsPerSend = (uint32_t)sendRds.toInt();
          if (readingsPerSend == 0 || readingsPerSend > 100) readingsPerSend = READINGS_PER_SEND_DEFAULT;
        } else {
          // Se riga 5 assente, imposta il valore di default accoppiato all'intervallo caricato
          uint32_t slMinVal = (uint32_t)(sleepUs / 60000000ULL);
          for (uint8_t i = 0; i < NUM_SLEEP_OPTIONS; i++) {
            if (SLEEP_OPTIONS_MIN[i] == slMinVal) {
              readingsPerSend = READINGS_OPTIONS[i];
              break;
            }
          }
        }
      }
    }
    LittleFS.end();
  }
}

static FLASH_FN void saveConfig(const String &ssid, const String &pass, const String &ep) {
  if (LittleFS.begin()) {
    File f = LittleFS.open(FPSTR(CONFIG_FILE), "w");
    if (f) {
      f.println(ssid); f.println(pass); f.println(ep);
      // Riga 4: salva l'intervallo sleep in minuti
      f.println((uint32_t)(sleepUs / 60000000ULL));
      // Riga 5: salva il parametro readingsPerSend
      f.println(readingsPerSend);
      f.close();
      DBG_PRINTLN(F("[CONF] Config salvata."));
    }
    LittleFS.end();
  }
}

static FLASH_FN void runWifiPortal();

static void turnOledOff() {
  display.ssd1306_command(0x8D); // CMD_CHARGEPUMP
  display.ssd1306_command(0x10); // CMD_PUMP_OFF
  display.ssd1306_command(0xAE); // CMD_DISPLAYOFF
}

static inline bool isDeepSleepWake() { return ESP.getResetInfoPtr()->reason == REASON_DEEP_SLEEP_AWAKE; }
static inline void wifiOff()          { WiFi.disconnect(true); WiFi.mode(WIFI_OFF); }

// =============================================================================
//  MENU FISICO TASTO FLASH (GPIO0)
//  Hold 5s  -> Menu impostazione intervallo sleep
//  Hold 10s -> Avvio diretto portale WiFi
// =============================================================================
// Nota: questa funzione e' chiamata all'inizio di setup() PRIMA del deep sleep check.
// Usa una funzione OLED inline per evitare dipendenze circolari con runWifiPortal.
static FLASH_FN void runFlashButtonMenu() {
  pinMode(PIN_FLASH, INPUT);  // GPIO0 ha gia' pull-up interno

  // Nessuna pressione: esci immediatamente (caso comune - risparmia corrente)
  if (digitalRead(PIN_FLASH) == HIGH) return;

  // Tasto premuto: inizializza OLED e aspetta il rilascio o la soglia
  recoverI2C(PIN_SDA_OLED, PIN_SCL_OLED);
  Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
  bool dispOk = display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) || display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL);

  uint32_t pressStart = millis();
  uint8_t  phase = 0; // 0 = attesa, 1 = menu tempi (5s), 2 = wifi (10s)

  auto showHoldMsg = [&](const char *line1, const char *line2) {
    if (!dispOk) return;
    display.clearDisplay();
    display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(22, 3);
    display.print(F("TASTO FLASH"));
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 20); display.print(line1);
    display.setCursor(0, 36); display.print(line2);
    display.display();
  };

  // Attesa con feedback visivo finche' il tasto e' premuto
  while (digitalRead(PIN_FLASH) == LOW) {
    uint32_t held = millis() - pressStart;
    if (held >= 10000UL && phase < 2) {
      phase = 2;
      showHoldMsg("RILASCIA ORA per", "PORTALE WIFI");
    } else if (held >= 5000UL && phase < 1) {
      phase = 1;
      showHoldMsg("RILASCIA ORA per", "IMPOSTARE TEMPI");
    }
    yield();
  }

  if (phase == 0) {
    // Pressione troppo breve (<5s): ignora, spegni schermo e ritorna
    if (dispOk) { turnOledOff(); }
    return;
  }

  if (phase == 2) {
    // Hold 10s: avvio portale WiFi diretto
    DBG_PRINTLN(F("[FLASH] Hold 10s -> Portale WiFi"));
    if (dispOk) { turnOledOff(); }
    loadConfig();
    runWifiPortal();
    return;
  }

  // Hold 5-9s: Menu di configurazione a due passaggi
  DBG_PRINTLN(F("[FLASH] Hold 5s -> Menu di configurazione"));
  loadConfig(); // carica config attuale

  // --- STEP 1: IMPOSTAZIONE INTERVALLO SLEEP (MISURA) ---
  uint8_t sleepIdx = 0;
  uint32_t curMin = (uint32_t)(sleepUs / 60000000ULL);
  for (uint8_t i = 0; i < NUM_SLEEP_OPTIONS; i++) {
    if (SLEEP_OPTIONS_MIN[i] == curMin) { sleepIdx = i; break; }
  }

  auto showSleepMenuOled = [&]() {
    if (!dispOk) return;
    display.clearDisplay();
    display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(10, 3);
    display.print(F("1. INTERVALLO MISURA"));
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 20); display.print(F("Click: cambia valore"));
    display.setCursor(0, 34); display.print(F("Attesa 3s: avanti"));
    char buf[16];
    snprintf(buf, sizeof(buf), "> %u min <", SLEEP_OPTIONS_MIN[sleepIdx]);
    display.setTextSize(1);
    display.setCursor((128 - (int)(strlen(buf)*6))/2, 50);
    display.print(buf);
    display.display();
  };

  showSleepMenuOled();

  uint32_t lastAction = millis();
  while (millis() - lastAction < 3000UL) {
    if (digitalRead(PIN_FLASH) == LOW) {
      while (digitalRead(PIN_FLASH) == LOW) yield();
      delay(50);
      sleepIdx = (sleepIdx + 1) % NUM_SLEEP_OPTIONS;
      lastAction = millis();
      showSleepMenuOled();
    }
    yield();
  }

  // --- STEP 2: IMPOSTAZIONE SOGLIA INVIO WIFI ---
  static const uint32_t SEND_OPTS[] = { 1, 3, 6, 12, 24 };
  static constexpr uint8_t NUM_SEND_OPTS = 5;
  uint8_t sendIdx = 3; // Default 12
  for (uint8_t i = 0; i < NUM_SEND_OPTS; i++) {
    if (SEND_OPTS[i] == readingsPerSend) { sendIdx = i; break; }
  }

  auto showSendMenuOled = [&]() {
    if (!dispOk) return;
    display.clearDisplay();
    display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(10, 3);
    display.print(F("2. SOGLIA INVIO WIFI"));
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 20); display.print(F("Click: cambia valore"));
    display.setCursor(0, 34); display.print(F("Attesa 3s: salva"));
    char buf[24];
    if (SEND_OPTS[sendIdx] == 1) {
      snprintf(buf, sizeof(buf), "> Ogni lettura <");
    } else {
      snprintf(buf, sizeof(buf), "> Ogni %u letture <", SEND_OPTS[sendIdx]);
    }
    display.setTextSize(1);
    display.setCursor((128 - (int)(strlen(buf)*6))/2, 50);
    display.print(buf);
    display.display();
  };

  showSendMenuOled();

  lastAction = millis();
  while (millis() - lastAction < 3000UL) {
    if (digitalRead(PIN_FLASH) == LOW) {
      while (digitalRead(PIN_FLASH) == LOW) yield();
      delay(50);
      sendIdx = (sendIdx + 1) % NUM_SEND_OPTS;
      lastAction = millis();
      showSendMenuOled();
    }
    yield();
  }

  // Salva le scelte su LittleFS
  sleepUs = (uint64_t)SLEEP_OPTIONS_MIN[sleepIdx] * 60ULL * 1000000ULL;
  readingsPerSend = SEND_OPTS[sendIdx];
  loadConfig(); // ricarica ssid/pass/ep per poter salvare
  saveConfig(wifiSsid, wifiPass, httpEndpoint);
  DBG_PRINTF("[FLASH] Salvato: %u min, %u letture per invio\n", SLEEP_OPTIONS_MIN[sleepIdx], readingsPerSend);

  // Feedback visivo di conferma
  if (dispOk) {
    display.clearDisplay();
    display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(22, 3);
    display.print(F("SALVATO!"));
    display.setTextColor(SSD1306_WHITE);
    char buf[32];
    snprintf(buf, sizeof(buf), "Misura: %u min", SLEEP_OPTIONS_MIN[sleepIdx]);
    display.setCursor(0, 20); display.print(buf);
    if (readingsPerSend == 1) {
      snprintf(buf, sizeof(buf), "Invio: Ogni lettura");
    } else {
      snprintf(buf, sizeof(buf), "Invio: Ogni %u letture", readingsPerSend);
    }
    display.setCursor(0, 32); display.print(buf);
    display.setCursor(20, 48); display.print(F("Riavvio in corso..."));
    display.display();
    { const uint32_t _t = millis(); while (millis() - _t < 2500UL) yield(); }
    turnOledOff();
  }
  ESP.restart();
}

// =============================================================================
//  PORTALE WiFi (identico all'originale)
// =============================================================================
static FLASH_FN void runWifiPortal() {
  uint8_t mac[6]; WiFi.macAddress(mac);
  char apName[32]; sprintf(apName, "Termoigrometro_%02X%02X", mac[4], mac[5]);

  Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
  bool dispOk = display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) || display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL);
  if (dispOk) {
    display.clearDisplay(); display.fillRect(0,0,128,14,SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(16,3); display.print(F("CONFIGURAZIONE"));
    display.setTextColor(SSD1306_WHITE); display.setCursor(0,24); display.print(F("Scansione reti...")); display.display();
  }

  WiFi.mode(WIFI_AP_STA); delay(100);
  int n_networks = WiFi.scanNetworks();
  WiFi.softAP(apName); delay(100);

  IPAddress apIP(192,168,4,1);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255,255,255,0));
  DNSServer dnsServer; dnsServer.start(53, "*", apIP);
  ESP8266WebServer webServer(80);

  if (dispOk) {
    display.clearDisplay(); display.fillRect(0,0,128,14,SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(16,3); display.print(F("CONFIGURAZIONE"));
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0,20); display.print(F("Connettiti al Wi-Fi:"));
    display.setCursor(0,32); display.print(apName);
    display.setCursor(0,48); display.print(F("Apri nel browser:"));
    display.setCursor(0,56); display.print(F("192.168.4.1"));
    display.display();
  }

  loadConfig();

  String wifiListHtml = "";
  if (n_networks <= 0) {
    wifiListHtml = F("<p style='color:#94a3b8;font-size:14px;text-align:center;'>Nessuna rete trovata.</p>");
  } else {
    wifiListHtml = F("<div class='wifi-list'>");
    int limit = (n_networks > 8) ? 8 : n_networks;
    for (int i = 0; i < limit; ++i) {
      String ssid = WiFi.SSID(i); int32_t rssi = WiFi.RSSI(i); uint8_t enc = WiFi.encryptionType(i);
      String sc = (rssi >= -67) ? "sig-strong" : ((rssi >= -75) ? "sig-medium" : "sig-weak");
      String lk = (enc != ENC_TYPE_NONE) ? " \xF0\x9F\x94\x92" : "";
      String es = ssid; es.replace("\\","\\\\"); es.replace("'","\\'"); es.replace("\"","\\\"");
      wifiListHtml += "<div class='wifi-item' onclick='selectWifi(\""+es+"\")'><span class='wifi-ssid'>"+ssid+lk+"</span><span class='wifi-rssi "+sc+"'>"+String(rssi)+" dBm</span></div>";
    }
    wifiListHtml += F("</div>");
  }

  webServer.on("/", [&webServer, &wifiListHtml]() {
    String html = F("<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'><title>Config</title><style>body{background:linear-gradient(135deg,#0f172a,#1e1b4b);color:#f8fafc;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:30px;width:100%;max-width:400px}h2{margin-top:0;text-align:center;color:#60a5fa}.group{margin-bottom:16px}label{display:block;font-size:13px;color:#94a3b8;margin-bottom:5px}input{width:100%;padding:10px;background:rgba(15,23,42,0.6);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:white;font-size:15px;box-sizing:border-box}button{width:100%;padding:13px;background:#3b82f6;color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}.wifi-list{max-height:130px;overflow-y:auto;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:rgba(15,23,42,0.4);margin-bottom:12px;padding:4px}.wifi-item{display:flex;justify-content:space-between;padding:7px 9px;cursor:pointer;border-radius:6px;font-size:13px}.wifi-item:hover{background:rgba(59,130,246,0.15)}.sig-strong{color:#10b981}.sig-medium{color:#f59e0b}.sig-weak{color:#ef4444}</style><script>function selectWifi(s){document.getElementById('ssid').value=s;document.getElementById('pass').focus();}</script></head><body><div class='card'><h2>Configurazione Wi-Fi</h2><form action='/save' method='POST'><div class='group'><label>Reti rilevate</label>{WIFI_LIST}</div><div class='group'><label for='ssid'>SSID</label><input type='text' id='ssid' name='ssid' required value='{SSID}'></div><div class='group'><label for='pass'>Password</label><input type='password' id='pass' name='pass' value='{PASS}'></div><div class='group'><label for='ep'>Endpoint API</label><input type='text' id='ep' name='ep' required value='{EP}'></div><button type='submit'>Salva</button></form></div></body></html>");
    html.replace("{WIFI_LIST}", wifiListHtml);
    html.replace("{SSID}", wifiSsid);
    html.replace("{PASS}", wifiPass);
    html.replace("{EP}", httpEndpoint);
    webServer.send(200, "text/html", html);
  });

  webServer.on("/save", HTTP_POST, [&webServer]() {
    String ssid = webServer.arg("ssid"); ssid.trim();
    String pass = webServer.arg("pass"); pass.trim();
    String ep   = webServer.arg("ep");   ep.trim();
    if (ssid.length() > 0 && ep.length() > 0) {
      saveConfig(ssid, pass, ep);
      rtcWifi.crc32 = 0; writeRTCWifi();
      webServer.send(200, "text/html", F("<!DOCTYPE html><html><body style='background:#0f172a;color:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;'><div style='text-align:center'><h2 style='color:#10b981'>Salvato!</h2><p>Il dispositivo si riavviera' tra poco.</p></div></body></html>"));
      { const uint32_t _t = millis(); while (millis() - _t < 2000UL) yield(); }
      // Spegne lo schermo OLED prima del riavvio per evitare che rimanga "congelato" acceso durante lo sleep successivo
      turnOledOff();
      ESP.restart();
    } else {
      webServer.send(400, "text/plain", "SSID e Endpoint obbligatori.");
    }
  });

  webServer.onNotFound([&webServer]() {
    String host = webServer.hostHeader();
    if (host == "192.168.4.1" || host.startsWith("192.168.4.1:")) webServer.send(404, "text/plain", "Not Found");
    else { webServer.sendHeader("Location", "http://192.168.4.1/", true); webServer.send(302, "text/plain", ""); }
  });

  webServer.begin();
  DBG_PRINTLN(F("[PORTAL] Portale avviato."));
  const uint32_t t_start = millis();
  while (millis() - t_start < 300000UL) { dnsServer.processNextRequest(); webServer.handleClient(); yield(); }

  turnOledOff();
  WiFi.mode(WIFI_OFF);
  DBG_PRINTLN(F("[PORTAL] Timeout  deepSleep..."));
  ESP.deepSleep(sleepUs, WAKE_RF_DISABLED);
}

// =============================================================================
//  AUTO-RILEVAMENTO PIN DEL SENSORE
// =============================================================================
static FLASH_FN bool detectSensorPins() {
  if (sensorPinsDetected) return true;

  // Lista di coppie di pin da testare: {SDA, SCL}
  // 1. D2/GPIO4, D1/GPIO5 (standard)
  // 2. D1/GPIO5, D2/GPIO4 (fili invertiti)
  // 3. D5/GPIO14, D6/GPIO12 (condiviso con display OLED)
  // 4. D6/GPIO12, D5/GPIO14 (condiviso con display OLED, invertito)
  const uint8_t pinPairs[][2] = {
    { 4, 5 },
    { 5, 4 },
    { 14, 12 },
    { 12, 14 }
  };

  for (uint8_t i = 0; i < 4; i++) {
    uint8_t sda = pinPairs[i][0];
    uint8_t scl = pinPairs[i][1];

    DBG_PRINTF("[SHT40] Test pinout %d: SDA=%d, SCL=%d...\n", i + 1, sda, scl);
    recoverI2C(sda, scl);
    Wire.begin(sda, scl);
    delay(10);

    // Tentativo rapido di comunicazione (Soft Reset 0x94)
    Wire.beginTransmission(0x44);
    Wire.write(0x94);
    if (Wire.endTransmission() == 0) {
      delay(15);
      if (sht4.begin(&Wire)) {
        sdaPinSht = sda;
        sclPinSht = scl;
        sensorPinsDetected = true;
        DBG_PRINTF("[SHT40] Sensore RILEVATO su SDA=%d, SCL=%d\n", sda, scl);
        return true;
      }
    }
  }

  DBG_PRINTLN(F("[SHT40] ERR: Sensore non trovato su nessun pin!"));
  return false;
}

// =============================================================================
//  LETTURA SENSORE SHT40 REALE
// =============================================================================
static FLASH_FN bool readSensor(int16_t &t10, int16_t &h10) {
  // Rileva automaticamente i pin prima di leggere
  if (!detectSensorPins()) {
    return false;
  }

  // 1. Ripristino completo del bus I2C del sensore SHT40.
  recoverI2C(sdaPinSht, sclPinSht);

  Wire.begin(sdaPinSht, sclPinSht);
  delay(2); // Minimo assestamento bus I2C

  // 2. Invio comando Soft Reset (0x94) direttamente via I2C al sensore SHT40.
  Wire.beginTransmission(0x44); // Indirizzo I2C default SHT40
  Wire.write(0x94);             // Comando Soft Reset
  Wire.endTransmission();
  delay(10); // Datasheet: 1ms dopo soft reset; usiamo 10ms per sicurezza

  // 3. Tentativi multipli di inizializzazione con delay crescenti.
  bool initOk = false;
  for (uint8_t attempt = 0; attempt < 5; attempt++) {
    if (sht4.begin(&Wire)) {
      initOk = true;
      break;
    }
    DBG_PRINTF("[SHT40] Init tentativo %d/5 fallito, retry...\n", attempt + 1);
    recoverI2C(sdaPinSht, sclPinSht);
    Wire.begin(sdaPinSht, sclPinSht);
    delay(50 * (attempt + 1)); // Delay crescente: 50, 100, 150, 200ms
  }

  if (!initOk) { DBG_PRINTLN(F("[SHT40] ERR: init dopo 5 tentativi")); return false; }
  sht4.setPrecision(SHT4X_HIGH_PRECISION);
  sht4.setHeater(SHT4X_NO_HEATER);
  
  // 4. Lettura con retry: il primo getEvent() dopo il wake puo' fallire.
  sensors_event_t hEv, tEv;
  bool readOk = false;
  for (uint8_t attempt = 0; attempt < 3; attempt++) {
    if (sht4.getEvent(&hEv, &tEv)) {
      readOk = true;
      break;
    }
    DBG_PRINTF("[SHT40] Lettura tentativo %d/3 fallita, retry...\n", attempt + 1);
    delay(50);
  }
  if (!readOk) { DBG_PRINTLN(F("[SHT40] ERR: lettura dopo 3 tentativi")); return false; }
  
  if (tEv.temperature < -40.0f || tEv.temperature > 125.0f ||
      hEv.relative_humidity < 0.0f || hEv.relative_humidity > 100.0f) {
    DBG_PRINTLN(F("[SHT40] ERR: fuori range")); return false;
  }
  
  t10 = static_cast<int16_t>(tEv.temperature * 10.0f + 0.5f);
  h10 = static_cast<int16_t>(hEv.relative_humidity * 10.0f + 0.5f);
  DBG_PRINTF("[SHT40] T=%s%d.%d C  H=%d.%d%%\n",
             (t10 < 0 ? "-" : ""), abs(t10)/10, abs(t10)%10, h10/10, h10%10);
  return true;
}

// =============================================================================
//  DATA LOGGING SU LITTLEFS
// =============================================================================
static FLASH_FN void saveMeasurement(int16_t t10, int16_t h10) {
  if (!LittleFS.begin()) { DBG_PRINTLN(F("[FS] ERR: mount")); return; }
  File f = LittleFS.open(FPSTR(DATA_FILE), "a");
  if (!f) { DBG_PRINTLN(F("[FS] ERR: open")); LittleFS.end(); return; }
  if (f.size() < FS_MAX_BYTES) {
    f.print(t10); f.print(','); f.println(h10);
    DBG_PRINTF("[FS] Dato accodato (file: %u byte)\n", (unsigned)f.size());
  } else {
    DBG_PRINTLN(F("[FS] WARN: file pieno, dato scartato"));
  }
  f.close(); LittleFS.end();
}

// =============================================================================
//  TRASMISSIONE WI-FI
// =============================================================================
static FLASH_FN void sendWiFiData() {
  DBG_PRINTLN(F("[WiFi] Connessione..."));
  WiFi.persistent(false); WiFi.mode(WIFI_STA);
  loadConfig();

  bool cacheValid = readRTCWifi();
  if (cacheValid) {
    DBG_PRINTF("[WiFi] Cache valido (canale %d)\n", rtcWifi.channel);
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str(), rtcWifi.channel, rtcWifi.bssid);
  } else {
    DBG_PRINTLN(F("[WiFi] Nessun cache, scansione completa..."));
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  }

  const uint32_t t0 = millis(); bool fallbackTried = false;
  while (WiFi.status() != WL_CONNECTED) {
    uint32_t el = millis() - t0;
    if (cacheValid && !fallbackTried && el >= 4000UL) {
      WiFi.disconnect(); delay(50); WiFi.begin(wifiSsid.c_str(), wifiPass.c_str()); fallbackTried = true;
    }
    if (el >= WIFI_TIMEOUT_MS) { DBG_PRINTLN(F("[WiFi] Timeout")); wifiOff(); return; }
    yield();
  }
  DBG_PRINTF("[WiFi] Connesso in %lu ms\n", millis() - t0);

  rtcWifi.channel = WiFi.channel(); memcpy(rtcWifi.bssid, WiFi.BSSID(), 6); rtcWifi.padding = 0;
  writeRTCWifi();

  if (!LittleFS.begin()) { DBG_PRINTLN(F("[FS] ERR mount per invio")); wifiOff(); return; }
  File f = LittleFS.open(FPSTR(DATA_FILE), "r");
  if (!f || f.size() == 0) { DBG_PRINTLN(F("[FS] Nessun dato")); if(f) f.close(); LittleFS.end(); wifiOff(); return; }
  DBG_PRINTF("[WiFi] Invio %u byte...\n", (unsigned)f.size());

  WiFiClientSecure client;
  client.setInsecure();
  client.setBufferSizes(4096, 512);  // 4096 RX sufficiente per API Vercel (riduce heap usage)
  HTTPClient http;
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(10000);
  bool sendOk = false;

  if (http.begin(client, httpEndpoint)) {
    http.addHeader(F("Content-Type"), F("text/csv"));
    http.addHeader(F("X-Device-ID"), WiFi.macAddress());
    char intervalStr[16];
    snprintf(intervalStr, sizeof(intervalStr), "%u", (unsigned)(sleepUs / 1000000ULL));
    http.addHeader(F("X-Reading-Interval"), intervalStr);
    const int code = http.sendRequest("POST", &f, f.size());
    DBG_PRINTF("[HTTP] Risposta: %d\n", code);
    if (code < 0) {
      DBG_PRINTF("[HTTP] Errore: %s\n", http.errorToString(code).c_str());
      char eb[100]; int e = client.getLastSSLError(eb, sizeof(eb));
      if (e) DBG_PRINTF("[SSL] %d - %s\n", e, eb);
    }
    sendOk = (code >= 200 && code < 300);
    http.end();
  } else { DBG_PRINTLN(F("[HTTP] ERR begin()")); }

  f.close(); LittleFS.end();

  if (sendOk) {
    LittleFS.begin(); LittleFS.remove(FPSTR(DATA_FILE)); LittleFS.end();
    rtcCounter.counter = 0; writeRTC(); writeRTCRfPrepared(0);
    DBG_PRINTLN(F("[WiFi] OK � file eliminato, counter azzerato"));
  } else {
    DBG_PRINTLN(F("[WiFi] FAIL � dati conservati"));
  }
  wifiOff();
}

// Mostra un messaggio di errore sul display per ~3s poi lo spegne.
// Fix B1: yield-loop invece di delay(3000) per non bloccare il watchdog.
static FLASH_FN void showError() {
  Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
  if (!display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) && !display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) return;
  display.clearDisplay(); display.fillRect(0,0,128,14,SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK); display.setCursor(22,3); display.print(F("[  ERRORE  ]"));
  display.setTextColor(SSD1306_WHITE); display.setTextSize(2); display.setCursor(34,18); display.print(F("ERRORE"));
  display.display();
  { const uint32_t _t = millis(); while (millis() - _t < 3000UL) yield(); }
  display.clearDisplay(); display.display();
  turnOledOff();
}

// =============================================================================
//  DISPLAY DATI LIVE
// =============================================================================
static FLASH_FN void runDisplayCycle(uint32_t durationMs = 10000UL) {
  Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
  if (!display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) && !display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
    DBG_PRINTLN(F("[OLED] ERR: init fallita")); return;
  }
  DBG_PRINTF("[OLED] Avvio ciclo display %lu ms\n", durationMs);

  uint32_t t0 = millis();
  while (millis() - t0 < durationMs) {
    // Check immediato tasto FLASH per entrare nel menu durante il display
    if (digitalRead(PIN_FLASH) == LOW) {
      DBG_PRINTLN(F("[OLED] FLASH premuto durante display"));
      runFlashButtonMenu();
      return;
    }

    int16_t t10 = 0, h10 = 0;
    if (readSensor(t10, h10)) {
      Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
      display.clearDisplay();
      display.fillRect(0, 0, 128, 16, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(22, 4);
      display.print(F("CLIMA AMBIENTE"));
      display.setTextColor(SSD1306_WHITE);

      char tempStr[10], humStr[10];
      if (t10 < 0) snprintf(tempStr, sizeof(tempStr), "-%d.%d\xF8""C", abs(t10)/10, abs(t10)%10);
      else          snprintf(tempStr, sizeof(tempStr), "%d.%d\xF8""C",  t10/10, t10%10);
      snprintf(humStr, sizeof(humStr), "%d.%d%% RH", h10/10, h10%10);

      display.setTextSize(3);
      display.setCursor((128 - (int)(strlen(tempStr)*18))/2, 17);
      display.print(tempStr);
      display.setTextSize(2);
      display.setCursor((128 - (int)(strlen(humStr)*12))/2, 41);
      display.print(humStr);
      display.setTextSize(1); display.setCursor(8, 57); display.print(F("Tieni FLASH per Menu"));
      display.display();
    }
    
    // Attesa di 1 secondo spezzata in check frequenti del tasto FLASH
    uint32_t ds = millis();
    while (millis() - ds < 1000UL) {
      if (digitalRead(PIN_FLASH) == LOW) {
        runFlashButtonMenu();
        return;
      }
      yield();
    }
  }

  turnOledOff();
  DBG_PRINTLN(F("[OLED] Display spento"));
}

// =============================================================================
//  SETUP E LOOP
// =============================================================================
void setup() {
  // 0. CHECK TASTO FLASH (prima di tutto, incluso il deep sleep check)
  // Rileva pressioni prolungate per menu impostazioni o portale WiFi.
  // runFlashButtonMenu() ritorna immediatamente se il tasto non e' premuto.
  recoverI2C(PIN_SDA_OLED, PIN_SCL_OLED);
  runFlashButtonMenu();

  // 1. LETTURA IMMEDIATA STATO RTC
  const bool autoWake = isDeepSleepWake();
  readRTCFlag();

  bool enterDisplayCycle  = false;
  bool isFirstManualReset = false;

  if (!autoWake) {
    if (rtcFlagWord == MAGIC_AWAIT) {
      enterDisplayCycle  = true;
      writeRTCFlag(0);
    } else {
      // Primo reset manuale: SCRIVIAMO IL FLAG MAGIC_AWAIT!
      writeRTCFlag(MAGIC_AWAIT);
      isFirstManualReset = true;
    }
  } else {
    // Se è un risveglio automatico, pulisce i flag sporchi
    if (rtcFlagWord != 0) {
      writeRTCFlag(0);
    }
  }

  // 2. RIPRISTINO HARDWARE
  recoverI2C(PIN_SDA_OLED, PIN_SCL_OLED);
  readRTCRfPrepared();

  if (!(autoWake && rtcRfPrepared == 1)) { WiFi.mode(WIFI_OFF); WiFi.forceSleepBegin(); }

  DBG_BEGIN(115200);
  DBG_PRINTLN(F("\n[BOOT] Termoigrometro ESP8266 v2.0"));

  if (!readRTC()) { DBG_PRINTLN(F("[RTC] CRC invalido - azzerato")); rtcCounter.counter = 0; writeRTC(); }
  if (rtcCounter.counter > 10000u) rtcCounter.counter = 0;

  // Carica la configurazione da LittleFS (incluso l'intervallo sleep)
  loadConfig();
  DBG_PRINTF("[RTC] Contatore: %lu / %u\n", rtcCounter.counter, readingsPerSend);

  if (!autoWake && rtcRfPrepared != 0) writeRTCRfPrepared(0);
  DBG_PRINTF("[BOOT] Modalita: %s | SDK: %s\n", autoWake ? "AUTO" : "MANUALE", ESP.getResetReason().c_str());

  if (isFirstManualReset) {
    DBG_PRINTLN(F("[BOOT] Primo Reset. Standby 2s..."));
    const uint32_t t_win = millis();
    while (millis() - t_win < DISPLAY_WIN_MS) {
      // Se l'utente preme FLASH durante la finestra di standby, entriamo nel menu
      if (digitalRead(PIN_FLASH) == LOW) {
        runFlashButtonMenu();
      }
      yield();
    }
    writeRTCFlag(0); WiFi.mode(WIFI_OFF);
    DBG_PRINTLN(F("[BOOT] Timeout - deepSleep..."));
    ESP.deepSleep(sleepUs, WAKE_RF_DISABLED); return;
  }

  if (autoWake && rtcRfPrepared == 1) {
    DBG_PRINTLN(F("[AUTO] Risveglio RF_DEFAULT per invio dati..."));
    WiFi.forceSleepWake(); delay(1);
    sendWiFiData();
    uint32_t elMs = millis(); uint64_t slMs = sleepUs / 1000ULL;
    uint64_t actUs = (slMs > (uint64_t)elMs) ? (slMs - (uint64_t)elMs) * 1000ULL : 0ULL;
    DBG_PRINTF("[BOOT] -> deepSleep %llu s\n", actUs / 1000000ULL);
    ESP.deepSleep(actUs, WAKE_RF_DISABLED); return;
  }

  // Lettura sensore SHT40 REALE con seconda chance.
  // Se il primo tentativo completo fallisce, aspettiamo 500ms e riproviamo
  // da zero. Questo copre i casi in cui il sensore necessita di piu' tempo
  // per stabilizzarsi dopo il risveglio dal deep sleep.
  int16_t t10 = 0, h10 = 0;
  bool sensorOk = readSensor(t10, h10);
  if (!sensorOk) {
    DBG_PRINTLN(F("[SHT40] Primo ciclo fallito. Pausa 500ms e secondo tentativo..."));
    delay(500);
    sensorOk = readSensor(t10, h10);
  }
  if (!sensorOk) {
    showError();
    ESP.deepSleep(sleepUs, WAKE_RF_DISABLED); return;
  }

  if (autoWake) {
    saveMeasurement(t10, h10);
    ++rtcCounter.counter; writeRTC();
    DBG_PRINTF("[RTC] Aggiornato: %lu\n", rtcCounter.counter);
    if (rtcCounter.counter >= readingsPerSend) {
      DBG_PRINTLN(F("[AUTO] Soglia raggiunta - invio con RF_DEFAULT..."));
      writeRTCRfPrepared(1);
      ESP.deepSleep(10000ULL, WAKE_RF_DEFAULT); return;
    } else {
      if (rtcRfPrepared != 0) writeRTCRfPrepared(0);
      DBG_PRINTF("[AUTO] %lu/%u - sleep RF_OFF\n", rtcCounter.counter, readingsPerSend);
    }
  } else {
    if (enterDisplayCycle) {
      DBG_PRINTLN(F("[MAN] Secondo Reset: Ciclo Display 10s"));
      runDisplayCycle(10000UL);
    }
  }

  uint32_t elMs = millis(); uint64_t slMs = sleepUs / 1000ULL;
  uint64_t actUs = (slMs > (uint64_t)elMs) ? (slMs - (uint64_t)elMs) * 1000ULL : 0ULL;
  DBG_PRINTF("[BOOT] -> deepSleep %llu s (sveglio %lu ms)\n", actUs / 1000000ULL, elMs);
  ESP.deepSleep(actUs, WAKE_RF_DISABLED);
}

void loop() { ESP.deepSleep(sleepUs, WAKE_RF_DISABLED); }
