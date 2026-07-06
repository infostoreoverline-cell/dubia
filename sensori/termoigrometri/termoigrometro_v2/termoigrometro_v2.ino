/*
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║     TERMOIGROMETRO ESP8266 — ULTRA LOW-POWER MOCK v2.0           ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  MCU      : ESP8266 (ESP-12F / NodeMCU)                         ║
 * ║  Sensore  : SIMULATO/FITTIZIO (Senza sensore fisico collegato)   ║
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
#include <DNSServer.h>
#include <ESP8266WebServer.h>


// ─── §2  CONFIGURAZIONE ───────────────────────────────────────────────────────
static const char WIFI_SSID[] PROGMEM = "ASUS";
static const char WIFI_PASS[] PROGMEM = "24no1998";
static const char HTTP_EP[]   PROGMEM = "https://okopipo-junglelab-vg32.vercel.app/api/ingest";
static const char DATA_FILE[] PROGMEM = "/dati.txt";
static const char CONFIG_FILE[] PROGMEM = "/config.txt";

static String wifiSsid;
static String wifiPass;
static String httpEndpoint;

static constexpr uint8_t  PIN_SDA_SHT       = 4;     // D2 — SDA SHT40 (Non usato per sensore fisico, mantenuto per compatibilità)
static constexpr uint8_t  PIN_SCL_SHT       = 5;     // D1 — SCL SHT40
static constexpr uint8_t  PIN_SDA_OLED      = 14;    // D5 — SDA OLED interno
static constexpr uint8_t  PIN_SCL_OLED      = 12;    // D6 — SCL OLED interno
static constexpr uint8_t  DISP_PRI          = 0x3C;
static constexpr uint8_t  DISP_FALL         = 0x3D;
static constexpr uint8_t  SCREEN_W          = 128;
static constexpr uint8_t  SCREEN_H          = 64;

// --- PARAMETRI DI PRODUZIONE (DATI REALI) ---
static constexpr uint64_t SLEEP_US          = 15ULL * 60ULL * 1000000ULL;  // 15 Minuti tra le letture
static constexpr uint32_t READINGS_PER_SEND = 12;                           // Invia dopo 12 letture (ogni 3 ore)

static constexpr uint32_t WIFI_TIMEOUT_MS   = 12000UL;
static constexpr uint32_t FS_MAX_BYTES      = 65536UL;
static constexpr uint32_t DISPLAY_WIN_MS    = 2000UL;  // Finestra doppio reset (ms)

// Comandi SSD1306 per spegnimento charge pump
static constexpr uint8_t CMD_CHARGEPUMP = 0x8D;
static constexpr uint8_t CMD_PUMP_OFF   = 0x10;
static constexpr uint8_t CMD_DISPLAYOFF = 0xAE;

// ─── §3  STRUTTURA RTC ────────────────────────────────────────────────────────
struct __attribute__((packed)) RtcCounter {
  uint32_t crc32;
  uint32_t counter;
};
static_assert(sizeof(RtcCounter) <= 8, "RtcCounter troppo grande");
static RtcCounter rtcCounter;

// Flag per il double-reset — salvato all'offset 2 (= 8 byte) della RAM RTC.
static constexpr uint8_t  RTC_FLAG_OFFSET = 2;        // in unità di uint32_t
static uint32_t rtcFlagWord = 0;                        // Caricato/scritto separatamente
static constexpr uint32_t MAGIC_AWAIT    = 0xD0B1E55;  // Valore "magic" = aspetta secondo reset
static constexpr uint32_t MAGIC_CONFIG_PORTAL = 0xC0DF16; // Valore "magic" = entra in configurazione portal
static constexpr uint32_t MAGIC_CONFIG_CONFIRM = 0xC0DF0B; // Valore "magic" = conferma config portal

// Struttura per il cache Wi-Fi — salvata all'offset 4 (16 byte) della RAM RTC.
struct __attribute__((packed)) RtcWifiCache {
  uint32_t crc32;
  uint8_t channel;
  uint8_t bssid[6];
  uint8_t padding; // Padding per allineamento a 12 byte (3 word da 32 bit)
};
static_assert(sizeof(RtcWifiCache) == 12, "RtcWifiCache deve essere di 12 byte");
static RtcWifiCache rtcWifi;

static constexpr uint8_t RTC_WIFI_OFFSET = 4; // offset in unità di uint32_t (occupa word 4, 5, 6)

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

// Helper per il cache Wi-Fi in RAM RTC
static bool readRTCWifi() {
  ESP.rtcUserMemoryRead(RTC_WIFI_OFFSET, reinterpret_cast<uint32_t *>(&rtcWifi), sizeof(rtcWifi));
  const uint8_t *payload = reinterpret_cast<const uint8_t *>(&rtcWifi.channel);
  return calcCRC32(payload, sizeof(rtcWifi) - sizeof(rtcWifi.crc32)) == rtcWifi.crc32;
}

static void writeRTCWifi() {
  const uint8_t *payload = reinterpret_cast<const uint8_t *>(&rtcWifi.channel);
  rtcWifi.crc32 = calcCRC32(payload, sizeof(rtcWifi) - sizeof(rtcWifi.crc32));
  ESP.rtcUserMemoryWrite(RTC_WIFI_OFFSET, reinterpret_cast<uint32_t *>(&rtcWifi), sizeof(rtcWifi));
}

static void loadConfig() {
  wifiSsid = FPSTR(WIFI_SSID);
  wifiPass = FPSTR(WIFI_PASS);
  httpEndpoint = FPSTR(HTTP_EP);

  if (LittleFS.begin()) {
    if (LittleFS.exists(FPSTR(CONFIG_FILE))) {
      File f = LittleFS.open(FPSTR(CONFIG_FILE), "r");
      if (f) {
        String ssid = f.readStringUntil('\n');
        ssid.trim();
        String pass = f.readStringUntil('\n');
        pass.trim();
        String ep = f.readStringUntil('\n');
        ep.trim();
        f.close();

        if (ssid.length() > 0 && ep.length() > 0) {
          wifiSsid = ssid;
          wifiPass = pass;
          httpEndpoint = ep;
          DBG_PRINTLN(F("[CONF] Config caricata da file."));
        }
      }
    }
    LittleFS.end();
  }
}

static void saveConfig(const String &ssid, const String &pass, const String &ep) {
  if (LittleFS.begin()) {
    File f = LittleFS.open(FPSTR(CONFIG_FILE), "w");
    if (f) {
      f.println(ssid);
      f.println(pass);
      f.println(ep);
      f.close();
      DBG_PRINTLN(F("[CONF] Nuova config salvata."));
    }
    LittleFS.end();
  }
}

static void runWifiPortal() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char apName[32];
  sprintf(apName, "Termoigrometro_%02X%02X", mac[4], mac[5]);
  
  Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
  if (display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) ||
      display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
    display.clearDisplay();
    display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
    display.setTextSize(1);
    display.setCursor(16, 3);
    display.print(F("CONFIGURAZIONE"));
    
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 24);
    display.print(F("Scansione reti..."));
    display.display();
  }
  
  WiFi.mode(WIFI_AP_STA);
  delay(100);
  int n_networks = WiFi.scanNetworks();
  
  WiFi.softAP(apName);
  delay(100);
  
  IPAddress apIP(192, 168, 4, 1);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
  
  DNSServer dnsServer;
  dnsServer.start(53, "*", apIP);
  
  ESP8266WebServer webServer(80);
  
  if (display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) ||
      display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
    display.clearDisplay();
    display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
    display.setTextSize(1);
    display.setCursor(16, 3);
    display.print(F("CONFIGURAZIONE"));
    
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 20);
    display.print(F("Connettiti al Wi-Fi:"));
    display.setCursor(0, 32);
    display.print(apName);
    
    display.setCursor(0, 48);
    display.print(F("Apri nel browser:"));
    display.setCursor(0, 56);
    display.print(F("192.168.4.1"));
    display.display();
  }
  
  loadConfig();
  
  String wifiListHtml = "";
  if (n_networks <= 0) {
    wifiListHtml = F("<p style='color:#94a3b8;font-size:14px;text-align:center;'>Nessuna rete trovata. Inserisci manualmente.</p>");
  } else {
    wifiListHtml = F("<div class='wifi-list'>");
    int limit = (n_networks > 8) ? 8 : n_networks;
    for (int i = 0; i < limit; ++i) {
      String ssid = WiFi.SSID(i);
      int32_t rssi = WiFi.RSSI(i);
      uint8_t enc = WiFi.encryptionType(i);
      
      String signalClass = "sig-weak";
      if (rssi >= -67) signalClass = "sig-strong";
      else if (rssi >= -75) signalClass = "sig-medium";
      
      String lockIcon = (enc != ENC_TYPE_NONE) ? " 🔒" : "";
      
      String escapedSsid = ssid;
      escapedSsid.replace("\\", "\\\\");
      escapedSsid.replace("'", "\\'");
      escapedSsid.replace("\"", "\\\"");
      
      wifiListHtml += "<div class='wifi-item' onclick='selectWifi(\"" + escapedSsid + "\")'>";
      wifiListHtml += "  <span class='wifi-ssid'>" + ssid + lockIcon + "</span>";
      wifiListHtml += "  <span class='wifi-rssi " + signalClass + "'>" + String(rssi) + " dBm</span>";
      wifiListHtml += "</div>";
    }
    wifiListHtml += F("</div>");
  }
  
  webServer.on("/", [&webServer, wifiListHtml]() {
    String html = F("<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'><title>Termoigrometro Config</title><style>body{background:linear-gradient(135deg, #0f172a, #1e1b4b);color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:30px;width:100%;max-width:400px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.3)}h2{margin-top:0;margin-bottom:24px;text-align:center;font-weight:700;background:linear-gradient(to right,#60a5fa,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.group{margin-bottom:20px}label{display:block;font-size:14px;font-weight:500;margin-bottom:6px;color:#94a3b8}input{width:100%;padding:12px;background:rgba(15,23,42,0.6);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:white;font-size:16px;box-sizing:border-box}input:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,0.3)}button{width:100%;padding:14px;background:linear-gradient(to right,#3b82f6,#2563eb);color:white;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;box-shadow:0 4px 6px -1px rgba(59,130,246,0.3)}.footer{text-align:center;margin-top:24px;font-size:12px;color:#64748b}.wifi-list{max-height:130px;overflow-y:auto;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:rgba(15,23,42,0.4);margin-bottom:15px;padding:5px}.wifi-item{display:flex;justify-content:space-between;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;border-radius:6px;transition:background 0.2s;font-size:14px}.wifi-item:last-child{border-bottom:none}.wifi-item:hover{background:rgba(59,130,246,0.15)}.wifi-ssid{font-weight:500;color:#f8fafc}.wifi-rssi{font-size:12px}.sig-strong{color:#10b981}.sig-medium{color:#f59e0b}.sig-weak{color:#ef4444}</style><script>function selectWifi(ssid){document.getElementById('ssid').value=ssid;document.getElementById('pass').focus();}</script></head><body><div class='card'><h2>Configurazione Wi-Fi</h2><form action='/save' method='POST'><div class='group'><label>Reti Wi-Fi Rilevate</label>{WIFI_LIST}</div><div class='group'><label for='ssid'>SSID della rete Wi-Fi</label><input type='text' id='ssid' name='ssid' placeholder='Nome rete o seleziona sopra' required value='{SSID}'></div><div class='group'><label for='pass'>Password Wi-Fi</label><input type='password' id='pass' name='pass' placeholder='••••••••' value='{PASS}'></div><div class='group'><label for='ep'>Endpoint API Ingest</label><input type='text' id='ep' name='ep' placeholder='https://...' required value='{EP}'></div><button type='submit'>Salva Configurazione</button></form><div class='footer'>D.U.B.I.A. &bull; Termoigrometro ESP8266</div></div></body></html>");
    html.replace("{WIFI_LIST}", wifiListHtml);
    html.replace("{SSID}", wifiSsid);
    html.replace("{PASS}", wifiPass);
    html.replace("{EP}", httpEndpoint);
    webServer.send(200, "text/html", html);
  });
  
  webServer.on("/save", HTTP_POST, [&webServer]() {
    String ssid = webServer.arg("ssid");
    String pass = webServer.arg("pass");
    String ep = webServer.arg("ep");
    
    ssid.trim();
    pass.trim();
    ep.trim();
    
    if (ssid.length() > 0 && ep.length() > 0) {
      saveConfig(ssid, pass, ep);
      
      rtcWifi.crc32 = 0;
      writeRTCWifi();
      
      String html = F("<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'><title>Configurazione Salvata</title><style>body{background:linear-gradient(135deg, #0f172a, #1e1b4b);color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:rgba(255,255,255,0.05);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:30px;width:100%;max-width:400px;text-align:center;box-shadow:0 10px 25px -5px rgba(0,0,0,0.3)}h2{color:#10b981;margin-top:0}p{color:#94a3b8;line-height:1.5}</style></head><body><div class='card'><h2>Configurazione Salvata!</h2><p>Il dispositivo si riavvierà tra pochi secondi per connettersi alla nuova rete Wi-Fi.</p><p>Puoi chiudere questa pagina.</p></div></body></html>");
      webServer.send(200, "text/html", html);
      
      delay(2000);
      ESP.restart();
    } else {
      webServer.send(400, "text/plain", "SSID e Endpoint sono obbligatori.");
    }
  });
  
  webServer.onNotFound([&webServer]() {
    String host = webServer.hostHeader();
    if (host == "192.168.4.1" || host.startsWith("192.168.4.1:")) {
      webServer.send(404, "text/plain", "Not Found");
    } else {
      webServer.sendHeader("Location", "http://192.168.4.1/", true);
      webServer.send(302, "text/plain", "");
    }
  });
  
  webServer.begin();
  DBG_PRINTLN(F("[PORTAL] Portale avviato."));
  
  const uint32_t t_start = millis();
  while (millis() - t_start < 300000UL) {
    dnsServer.processNextRequest();
    webServer.handleClient();
    yield();
  }
  
  display.ssd1306_command(CMD_CHARGEPUMP);
  display.ssd1306_command(CMD_PUMP_OFF);
  display.ssd1306_command(CMD_DISPLAYOFF);
  WiFi.mode(WIFI_OFF);
  DBG_PRINTLN(F("[PORTAL] Timeout 5 min scaduto — deepSleep..."));
  ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED);
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
    DBG_PRINTF("[FS] Dato fittizio accodato (file: %u byte)\n", (unsigned)f.size());
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

  loadConfig(); // Carica le credenziali configurate

  bool cacheValid = readRTCWifi();
  if (cacheValid) {
    DBG_PRINTF("[WiFi] Connessione veloce su canale %d, BSSID: %02X:%02X:%02X:%02X:%02X:%02X\n",
               rtcWifi.channel, rtcWifi.bssid[0], rtcWifi.bssid[1], rtcWifi.bssid[2],
               rtcWifi.bssid[3], rtcWifi.bssid[4], rtcWifi.bssid[5]);
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str(), rtcWifi.channel, rtcWifi.bssid);
  } else {
    DBG_PRINTLN(F("[WiFi] Nessun cache valido, scansione completa..."));
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  }

  const uint32_t t0 = millis();
  bool fallbackTried = false;
  
  while (WiFi.status() != WL_CONNECTED) {
    uint32_t elapsed = millis() - t0;
    
    if (cacheValid && !fallbackTried && elapsed >= 4000UL) {
      DBG_PRINTLN(F("[WiFi] Connessione veloce fallita (timeout 4s), provo scansione completa..."));
      WiFi.disconnect();
      delay(50);
      WiFi.begin(FPSTR(WIFI_SSID), FPSTR(WIFI_PASS));
      fallbackTried = true;
    }
    
    if (elapsed >= WIFI_TIMEOUT_MS) {
      DBG_PRINTLN(F("[WiFi] Timeout connessione — dati fittizi preservati"));
      wifiOff();
      return;
    }
    yield();
  }
  
  DBG_PRINTF("[WiFi] Connesso in %lu ms\n", millis() - t0);

  // Aggiorna cache Wi-Fi in RTC
  rtcWifi.channel = WiFi.channel();
  memcpy(rtcWifi.bssid, WiFi.BSSID(), 6);
  rtcWifi.padding = 0;
  writeRTCWifi();
  DBG_PRINTF("[WiFi] Cache Wi-Fi aggiornato (Canale %d)\n", rtcWifi.channel);

  if (!LittleFS.begin()) { DBG_PRINTLN(F("[FS] ERR: mount per invio")); wifiOff(); return; }

  File f = LittleFS.open(FPSTR(DATA_FILE), "r");
  if (!f || f.size() == 0) {
    DBG_PRINTLN(F("[FS] Nessun dato da inviare"));
    if (f) f.close();
    LittleFS.end(); wifiOff(); return;
  }
  DBG_PRINTF("[WiFi] Invio %u byte di dati...\n", (unsigned)f.size());
  DBG_PRINTF("[WiFi] Endpoint: %s\n", httpEndpoint.c_str());
  DBG_PRINTF("[WiFi] Heap libero: %u byte\n", ESP.getFreeHeap());

  WiFiClientSecure client;
  client.setInsecure();
  // Buffer rx 16KB (necessario per ricevere la catena certificati Cloudflare/Vercel)
  // Buffer tx 512 byte (sufficiente per il nostro piccolo POST CSV)
  // Risparmia ~15KB di heap rispetto al default (16KB+16KB)
  client.setBufferSizes(16384, 512);
  HTTPClient http;
  bool sendOk = false;

  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.setTimeout(10000);

  if (http.begin(client, httpEndpoint)) {
    http.addHeader(F("Content-Type"), F("text/csv"));
    http.addHeader(F("X-Device-ID"), WiFi.macAddress());
    
    // Invia l'intervallo di misura in secondi come header
    char intervalStr[16];
    sprintf(intervalStr, "%llu", SLEEP_US / 1000000ULL);
    http.addHeader(F("X-Reading-Interval"), intervalStr);
    
    DBG_PRINTF("[WiFi] Heap prima di sendRequest: %u byte\n", ESP.getFreeHeap());
    const int code = http.sendRequest("POST", &f, f.size());
    DBG_PRINTF("[HTTP] Risposta: %d\n", code);
    if (code < 0) {
      DBG_PRINTF("[HTTP] Errore: %s\n", http.errorToString(code).c_str());
      char errBuf[100];
      int err = client.getLastSSLError(errBuf, sizeof(errBuf));
      if (err != 0) {
        DBG_PRINTF("[SSL] Error Code: %d - %s\n", err, errBuf);
      }
    }
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

// Spegne il display in caso di errore (Non usato nel mock visto che non può esserci errore sensore)
static void showError() {
  Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
  if (!display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) &&
      !display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
    return;
  }
  display.clearDisplay();
  display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setCursor(22, 3);
  display.print(F("[  ERRORE  ]"));
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(34, 18);
  display.print(F("ERRORE"));
  display.display();
  delay(3000);
  display.ssd1306_command(CMD_CHARGEPUMP);
  display.ssd1306_command(CMD_PUMP_OFF);
  display.ssd1306_command(CMD_DISPLAYOFF);
}

// =============================================================================
//  DISPLAY DATI LIVE — Mostra i valori fittizi per durationMs millisecondi
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

      // Header
      display.fillRect(0, 0, 128, 16, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
      display.setTextSize(1);
      display.setCursor(22, 4);
      display.print(F("CLIMA AMBIENTE"));

      // Dati
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
      int tempWidth = strlen(tempStr) * 18;
      display.setCursor((128 - tempWidth) / 2, 17);
      display.print(tempStr);

      // Umidità
      display.setTextSize(2);
      int humWidth = strlen(humStr) * 12;
      display.setCursor((128 - humWidth) / 2, 41);
      display.print(humStr);

      // Prompt per config
      display.setTextSize(1);
      display.setCursor(16, 57);
      display.print(F("RESET per Config"));

      display.display();
    }

    writeRTCFlag(MAGIC_CONFIG_PORTAL);

    uint32_t delayStart = millis();
    while (millis() - delayStart < 1000UL) {
      yield();
    }
  }

  writeRTCFlag(0);

  display.ssd1306_command(CMD_CHARGEPUMP);
  display.ssd1306_command(CMD_PUMP_OFF);
  display.ssd1306_command(CMD_DISPLAYOFF);
  DBG_PRINTLN(F("[OLED] Display spento — standby"));
}

// =============================================================================
//  SETUP E LOOP
// =============================================================================
void setup() {
  readRTCRfPrepared();
  const bool autoWake = isDeepSleepWake();

  // Spegni la radio all'avvio se non è un invio automatico programmato
  if (!(autoWake && rtcRfPrepared == 1)) {
    WiFi.mode(WIFI_OFF);
    WiFi.forceSleepBegin();
  }

  DBG_BEGIN(115200);
  DBG_PRINTLN(F("\n[BOOT] Termoigrometro ESP8266 v2.0 [SIMULATION MOCK]"));

  // Inizializza contatore in RAM RTC
  if (!readRTC()) {
    DBG_PRINTLN(F("[RTC] CRC invalido — primo avvio, contatore azzerato"));
    rtcCounter.counter = 0;
    writeRTC();
  }
  if (rtcCounter.counter > 10000u) rtcCounter.counter = READINGS_PER_SEND;
  DBG_PRINTF("[RTC] Contatore: %lu / %u\n", rtcCounter.counter, READINGS_PER_SEND);

  readRTCFlag();

  if (!autoWake && rtcRfPrepared != 0) {
    writeRTCRfPrepared(0);
  }
  DBG_PRINTF("[BOOT] Modalita: %s | SDK: %s\n",
             autoWake ? "AUTO" : "MANUALE", ESP.getResetReason().c_str());

  // Rilevamento reset per modalita' configurazione o double-reset
  bool manualOverride = false;
  bool enterConfigPortal = false;
  bool enterConfigConfirm = false;

  if (rtcFlagWord == MAGIC_AWAIT) {
    DBG_PRINTLN(F("[BOOT] *** Double-Reset rilevato! Attivo display 5s ***"));
    manualOverride = true;
    writeRTCFlag(0);
  } else if (rtcFlagWord == MAGIC_CONFIG_PORTAL) {
    DBG_PRINTLN(F("[BOOT] *** Reset durante display: attesa conferma per Config Portal ***"));
    enterConfigConfirm = true;
    writeRTCFlag(0);
  } else if (rtcFlagWord == MAGIC_CONFIG_CONFIRM) {
    DBG_PRINTLN(F("[BOOT] *** Reset confermato: entro in Config Portal! ***"));
    enterConfigPortal = true;
    writeRTCFlag(0);
  }

  // Logica conferma configurazione
  if (enterConfigConfirm) {
    Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
    if (display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) ||
        display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
      display.clearDisplay();
      display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
      display.setTextSize(1);
      display.setCursor(26, 3);
      display.print(F("CONFIGURAZIONE"));
      
      display.setTextColor(SSD1306_WHITE);
      display.setTextSize(1);
      display.setCursor(16, 24);
      display.print(F("Premi RESET ora"));
      display.setCursor(22, 36);
      display.print(F("per confermare"));
      
      display.fillRect(14, 52, 100, 2, SSD1306_WHITE);
      display.display();
    }
    
    writeRTCFlag(MAGIC_CONFIG_CONFIRM);
    
    const uint32_t t_win = millis();
    while (millis() - t_win < 5000UL) {
      yield();
    }
    
    writeRTCFlag(0);
    display.ssd1306_command(CMD_CHARGEPUMP);
    display.ssd1306_command(CMD_PUMP_OFF);
    display.ssd1306_command(CMD_DISPLAYOFF);
    WiFi.mode(WIFI_OFF);
    DBG_PRINTLN(F("[BOOT] Conferma scaduta — deepSleep..."));
    ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED);
    return;
  }

  if (enterConfigPortal) {
    runWifiPortal();
  }

  // TRASMISSIONE DIRETTA (se RF preparata)
  if (autoWake && rtcRfPrepared == 1) {
    DBG_PRINTLN(F("[AUTO] Risveglio RF_DEFAULT per invio dati fittizi..."));
    WiFi.forceSleepWake();
    delay(1);
    sendWiFiData();

    uint32_t elapsedMs = millis();
    uint32_t sleepMs = SLEEP_US / 1000ULL;
    uint64_t actualSleepUs = (elapsedMs < sleepMs) ? (sleepMs - elapsedMs) * 1000ULL : 1000000ULL;
    DBG_PRINTF("[BOOT] → deepSleep %llu s (sveglio per %lu ms)\n", actualSleepUs / 1000000ULL, elapsedMs);
    ESP.deepSleep(actualSleepUs, WAKE_RF_DISABLED);
    return;
  }

  // ── Lettura sensore ───────────────────────────────────────────────────────
  int16_t t10, h10;
  if (!readSensor(t10, h10)) {
    DBG_PRINTLN(F("[ERR] Sensore — mostro errore su display, poi sleep"));
    writeRTCFlag(0);  // Resetta flag in caso di errore
    showError();
    ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED);
    return;
  }

  // Logica Principale
  if (!manualOverride) {
    if (!autoWake) {
      writeRTCFlag(MAGIC_AWAIT);
      DBG_PRINTF("[BOOT] Avvio manuale: finestra double-reset aperta (%lu ms)...\n", DISPLAY_WIN_MS);

      const uint32_t t_win = millis();
      while (millis() - t_win < DISPLAY_WIN_MS) {
        yield();
      }

      writeRTCFlag(0);
      DBG_PRINTLN(F("[BOOT] Finestra chiusa senza reset."));
    }

    // Salva misurazione reale e aggiorna contatore
    saveMeasurement(t10, h10);
    ++rtcCounter.counter;
    writeRTC();
    DBG_PRINTF("[RTC] Aggiornato: %lu\n", rtcCounter.counter);

    if (autoWake) {
      if (rtcCounter.counter >= READINGS_PER_SEND) {
        DBG_PRINTLN(F("[AUTO] Soglia raggiunta — riavvio rapido con RF_DEFAULT per calibrazione..."));
        writeRTCRfPrepared(1);
        ESP.deepSleep(10000ULL, WAKE_RF_DEFAULT);
        return;
      } else {
        if (rtcRfPrepared != 0) {
          writeRTCRfPrepared(0);
        }
        DBG_PRINTF("[AUTO] %lu/%u — sleep RF_OFF\n", rtcCounter.counter, READINGS_PER_SEND);
      }
    } else {
      // Avvio manuale: mostra i dati e invia immediatamente per agevolare il test
      DBG_PRINTLN(F("[MAN] Avvio a freddo — Ciclo Display 10s"));
      runDisplayCycle(10000UL);

      DBG_PRINTLN(F("[MAN] Invio dati immediato post-display..."));
      WiFi.forceSleepWake();
      delay(1);
      sendWiFiData();
    }
  } else {
    // DOUBLE-RESET (Solo display per 10s, nessun salvataggio o invio)
    DBG_PRINTLN(F("[MAN] Ciclo Display 10s (double-reset)"));
    runDisplayCycle(10000UL);
  }

  uint32_t elapsedMs = millis();
  uint32_t sleepMs = SLEEP_US / 1000ULL;
  uint64_t actualSleepUs = (elapsedMs < sleepMs) ? (sleepMs - elapsedMs) * 1000ULL : 1000000ULL;

  DBG_PRINTF("[BOOT] → deepSleep %llu s (sveglio per %lu ms)\n", actualSleepUs / 1000000ULL, elapsedMs);
  ESP.deepSleep(actualSleepUs, WAKE_RF_DISABLED);
}

void loop() { ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED); }
