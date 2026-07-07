/*
 * +==================================================================+
 * |   TERMOIGROMETRO ESP8266 -- ULTRA LOW-POWER v2.0 (PRODUZIONE)   |
 * +==================================================================+
 * |  MCU      : ESP8266 (ESP-12F / NodeMCU)                         |
 * |  Sensore  : SHT40 (I2C su D2/D1)                               |
 * |  Display  : SSD1306 0.96 OLED -- I2C su D5(SDA=14) e D6(12) |
 * | Storage : LittleFS (Flash interna) |
 * | REQUISITO HW: collegare GPIO16 (D0) a RST per il wake-up |
 * +==================================================================+
 *
 * ATTIVAZIONE SCHERMO MANUALE: doppio click sul tasto RESET
 * entro 2 secondi dall avvio (durante la finestra di standby).
 *
 * CICLO AUTOMATICO: misura ogni 15 min, invia ogni 12 letture (3 ore).
 */

// --- S0 DEBUG ---
// Commentare per build di produzione: Serial OFF -> risparmio ~1-2 mA e ~5 ms.
#define DEBUG

#ifdef DEBUG
#define DBG_BEGIN(b) do { Serial.begin(b); delay(10); } while (0)
#define DBG_PRINT(x) Serial.print(x)
#define DBG_PRINTLN(x) Serial.println(x)
#define DBG_PRINTF(...) Serial.printf(__VA_ARGS__)
#else
#define DBG_BEGIN(b)
#define DBG_PRINT(x)
#define DBG_PRINTLN(x)
#define DBG_PRINTF(...)
#endif

// --- S1 LIBRERIE ---
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

// --- S2 CONFIGURAZIONE ---
// NOTA SICUREZZA: credenziali fallback hardcoded -- usate solo se config.txt e assente.
static const char WIFI_SSID[] PROGMEM = ASUS;
static const char WIFI_PASS[] PROGMEM = 24no1998;
static const char HTTP_EP[] PROGMEM = https://okopipo-junglelab-vg32.vercel.app/api/ingest;
static const char DATA_FILE[] PROGMEM = /dati.txt;
static const char CONFIG_FILE[] PROGMEM = /config.txt;

static String wifiSsid;
static String wifiPass;
static String httpEndpoint;

static constexpr uint8_t PIN_SDA_SHT = 4; // D2 -- SDA SHT40
static constexpr uint8_t PIN_SCL_SHT = 5; // D1 -- SCL SHT40
static constexpr uint8_t PIN_SDA_OLED = 14; // D5 -- SDA OLED
static constexpr uint8_t PIN_SCL_OLED = 12; // D6 -- SCL OLED
static constexpr uint8_t DISP_PRI = 0x3C;
static constexpr uint8_t DISP_FALL = 0x3D;
static constexpr uint8_t SCREEN_W = 128;
static constexpr uint8_t SCREEN_H = 64;

// --- PARAMETRI DI PRODUZIONE ---
static constexpr uint64_t SLEEP_US = 15ULL * 60ULL * 1000000ULL; // 15 minuti tra le letture
static constexpr uint32_t READINGS_PER_SEND = 12; // Invia dopo 12 letture (3 ore)

static constexpr uint32_t WIFI_TIMEOUT_MS = 12000UL;
static constexpr uint32_t FS_MAX_BYTES = 65536UL;
static constexpr uint32_t DISPLAY_WIN_MS = 2000UL; // Finestra doppio reset (ms)

// Comandi SSD1306 per spegnimento charge pump
static constexpr uint8_t CMD_CHARGEPUMP = 0x8D;
static constexpr uint8_t CMD_PUMP_OFF = 0x10;
static constexpr uint8_t CMD_DISPLAYOFF = 0xAE;

// --- S3 STRUTTURA RTC ---
struct __attribute__((packed)) RtcCounter {
 uint32_t crc32;
 uint32_t counter;
};
static_assert(sizeof(RtcCounter) <= 8, RtcCounter troppo grande);
static RtcCounter rtcCounter;

static constexpr uint8_t RTC_FLAG_OFFSET = 2;
static uint32_t rtcFlagWord = 0;
static constexpr uint32_t MAGIC_AWAIT = 0xD0B1E55;
static constexpr uint32_t MAGIC_CONFIG_PORTAL = 0xC0DF16;
static constexpr uint32_t MAGIC_CONFIG_CONFIRM = 0xC0DF0B;

struct __attribute__((packed)) RtcWifiCache {
 uint32_t crc32;
 uint8_t channel;
 uint8_t bssid[6];
 uint8_t padding;
};
static_assert(sizeof(RtcWifiCache) == 12, RtcWifiCache deve essere di 12 byte);
static RtcWifiCache rtcWifi;

static constexpr uint8_t RTC_WIFI_OFFSET = 4;
static constexpr uint8_t RTC_RF_OFFSET = 3;

// Verifica a compile-time che i blocchi RTC non si sovrappongano.
static_assert(RTC_FLAG_OFFSET * 4u >= sizeof(RtcCounter), RTC Flag sovrapposto a RtcCounter!);
static_assert(RTC_RF_OFFSET * 4u >= (RTC_FLAG_OFFSET * 4u + 4u), RTC RF sovrapposto a Flag!);
static_assert(RTC_WIFI_OFFSET * 4u >= (RTC_RF_OFFSET * 4u + 4u), RTC WiFi sovrapposto a RF!);

// --- S4 OGGETTI GLOBALI ---
static Adafruit_SHT4x sht4;
static Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);

// =============================================================================
// UTILITA CRC
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

static bool readRTC() {
 ESP.rtcUserMemoryRead(0, reinterpret_cast<uint32_t *>(&rtcCounter), sizeof(rtcCounter));
 const uint8_t *p = reinterpret_cast<const uint8_t *>(&rtcCounter.counter);
 return calcCRC32(p, sizeof(rtcCounter.counter)) == rtcCounter.crc32;
}

static void writeRTC() {
 const uint8_t *p = reinterpret_cast<const uint8_t *>(&rtcCounter.counter);
 rtcCounter.crc32 = calcCRC32(p, sizeof(rtcCounter.counter));
 ESP.rtcUserMemoryWrite(0, reinterpret_cast<uint32_t *>(&rtcCounter), sizeof(rtcCounter));
}

static void readRTCFlag() { ESP.rtcUserMemoryRead(RTC_FLAG_OFFSET, &rtcFlagWord, sizeof(rtcFlagWord)); }
static void writeRTCFlag(uint32_t v) { rtcFlagWord = v; ESP.rtcUserMemoryWrite(RTC_FLAG_OFFSET, &rtcFlagWord, sizeof(rtcFlagWord)); }

static uint32_t rtcRfPrepared = 0;
static void readRTCRfPrepared() { ESP.rtcUserMemoryRead(RTC_RF_OFFSET, &rtcRfPrepared, sizeof(rtcRfPrepared)); }
static void writeRTCRfPrepared(uint32_t v) { rtcRfPrepared = v; ESP.rtcUserMemoryWrite(RTC_RF_OFFSET, &rtcRfPrepared, sizeof(rtcRfPrepared)); }

static bool readRTCWifi() {
 ESP.rtcUserMemoryRead(RTC_WIFI_OFFSET, reinterpret_cast<uint32_t *>(&rtcWifi), sizeof(rtcWifi));
 const uint8_t *p = reinterpret_cast<const uint8_t *>(&rtcWifi.channel);
 return calcCRC32(p, sizeof(rtcWifi) - sizeof(rtcWifi.crc32)) == rtcWifi.crc32;
}

static void writeRTCWifi() {
 const uint8_t *p = reinterpret_cast<const uint8_t *>(&rtcWifi.channel);
 rtcWifi.crc32 = calcCRC32(p, sizeof(rtcWifi) - sizeof(rtcWifi.crc32));
 ESP.rtcUserMemoryWrite(RTC_WIFI_OFFSET, reinterpret_cast<uint32_t *>(&rtcWifi), sizeof(rtcWifi));
}

static void recoverI2C(uint8_t sdaPin, uint8_t sclPin) {
 pinMode(sdaPin, INPUT_PULLUP);
 pinMode(sclPin, OUTPUT);
 if (digitalRead(sdaPin) == HIGH) { pinMode(sdaPin, INPUT); pinMode(sclPin, INPUT); return; }
 for (uint8_t i = 0; i < 9; i++) {
 digitalWrite(sclPin, LOW); delayMicroseconds(5);
 digitalWrite(sclPin, HIGH); delayMicroseconds(5);
 if (digitalRead(sdaPin) == HIGH) break;
 }
 // Genera condizione di STOP
 pinMode(sdaPin, OUTPUT);
 digitalWrite(sdaPin, LOW); delayMicroseconds(5);
 digitalWrite(sclPin, HIGH); delayMicroseconds(5);
 digitalWrite(sdaPin, HIGH); delayMicroseconds(5);
 pinMode(sdaPin, INPUT); pinMode(sclPin, INPUT);
}

static void loadConfig() {
 wifiSsid = FPSTR(WIFI_SSID); wifiPass = FPSTR(WIFI_PASS); httpEndpoint = FPSTR(HTTP_EP);
 if (LittleFS.begin()) {
 if (LittleFS.exists(FPSTR(CONFIG_FILE))) {
 File f = LittleFS.open(FPSTR(CONFIG_FILE), r);
 if (f) {
 String s = f.readStringUntil('\n'); s.trim();
 String p = f.readStringUntil('\n'); p.trim();
 String e = f.readStringUntil('\n'); e.trim();
 f.close();
 if (s.length() > 0 && e.length() > 0) {
 wifiSsid = s; wifiPass = p; httpEndpoint = e;
 DBG_PRINTLN(F([CONF] Config caricata da file.));
 }
 }
 }
 LittleFS.end();
 }
}

static void saveConfig(const String &ssid, const String &pass, const String &ep) {
 if (LittleFS.begin()) {
 File f = LittleFS.open(FPSTR(CONFIG_FILE), w);
 if (f) { f.println(ssid); f.println(pass); f.println(ep); f.close(); DBG_PRINTLN(F([CONF] Config salvata.)); }
 LittleFS.end();
 }
}

static inline bool isDeepSleepWake() { return ESP.getResetInfoPtr()->reason == REASON_DEEP_SLEEP_AWAKE; }
static inline void wifiOff() { WiFi.disconnect(true); WiFi.mode(WIFI_OFF); }

// =============================================================================
// PORTALE WIFI DI CONFIGURAZIONE
// =============================================================================
static void runWifiPortal() {
 uint8_t mac[6]; WiFi.macAddress(mac);
 char apName[32]; sprintf(apName, Termoigrometro_%02X%02X, mac[4], mac[5]);

 Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
 bool dispOk = display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) || display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL);
 if (dispOk) {
 display.clearDisplay(); display.fillRect(0,0,128,14,SSD1306_WHITE);
 display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(16,3); display.print(F(CONFIGURAZIONE));
 display.setTextColor(SSD1306_WHITE); display.setCursor(0,24); display.print(F(Scansione reti...)); display.display();
 }

 WiFi.mode(WIFI_AP_STA); delay(100);
 int n_networks = WiFi.scanNetworks();
 WiFi.softAP(apName); delay(100);

 IPAddress apIP(192,168,4,1);
 WiFi.softAPConfig(apIP, apIP, IPAddress(255,255,255,0));
 DNSServer dnsServer; dnsServer.start(53, *, apIP);
 ESP8266WebServer webServer(80);

 if (dispOk) {
 display.clearDisplay(); display.fillRect(0,0,128,14,SSD1306_WHITE);
 display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(16,3); display.print(F(CONFIGURAZIONE));
 display.setTextColor(SSD1306_WHITE);
 display.setCursor(0,20); display.print(F(Connettiti al Wi-Fi:));
 display.setCursor(0,32); display.print(apName);
 display.setCursor(0,48); display.print(F(Apri nel browser:));
 display.setCursor(0,56); display.print(F(192.168.4.1));
 display.display();
 }

 loadConfig();

 String wifiListHtml = ;
 if (n_networks <= 0) {
 wifiListHtml = F(<p style='color:#94a3b8;font-size:14px;text-align:center;'>Nessuna rete trovata.</p>);
 } else {
 wifiListHtml = F(<div class='wifi-list'>);
 int limit = (n_networks > 8) ? 8 : n_networks;
 for (int i = 0; i < limit; ++i) {
 String ssid = WiFi.SSID(i); int32_t rssi = WiFi.RSSI(i); uint8_t enc = WiFi.encryptionType(i);
 String sc = (rssi >= -67) ? sig-strong : ((rssi >= -75) ? sig-medium : sig-weak);
 String lk = (enc != ENC_TYPE_NONE) ?  \xF0\x9F\x94\x92 : ;
 String es = ssid; es.replace(\,\\); es.replace(',\\'); es.replace(",\");
 wifiListHtml += <div class='wifi-item' onclick='selectWifi("+es+")'><span class='wifi-ssid'>+ssid+lk+</span><span class='wifi-rssi +sc+'>+String(rssi)+ dBm</span></div>;
 }
 wifiListHtml += F(</div>);
 }

 // M3: cattura by-ref per evitare copia ~2KB di HTML sull heap dell ESP8266.
 webServer.on(/, [&webServer, &wifiListHtml]() {
 String html = F(<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width, initial-scale=1.0'><title>Config</title><style>body{background:linear-gradient(135deg,#0f172a,#1e1b4b);color:#f8fafc;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:30px;width:100%;max-width:400px}h2{margin-top:0;text-align:center;color:#60a5fa}.group{margin-bottom:16px}label{display:block;font-size:13px;color:#94a3b8;margin-bottom:5px}input{width:100%;padding:10px;background:rgba(15,23,42,0.6);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:white;font-size:15px;box-sizing:border-box}button{width:100%;padding:13px;background:#3b82f6;color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}.wifi-list{max-height:130px;overflow-y:auto;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:rgba(15,23,42,0.4);margin-bottom:12px;padding:4px}.wifi-item{display:flex;justify-content:space-between;padding:7px 9px;cursor:pointer;border-radius:6px;font-size:13px}.wifi-item:hover{background:rgba(59,130,246,0.15)}.sig-strong{color:#10b981}.sig-medium{color:#f59e0b}.sig-weak{color:#ef4444}</style><script>function selectWifi(s){document.getElementById('ssid').value=s;document.getElementById('pass').focus();}</script></head><body><div class='card'><h2>Configurazione Wi-Fi</h2><form action='/save' method='POST'><div class='group'><label>Reti rilevate</label>{WIFI_LIST}</div><div class='group'><label for='ssid'>SSID</label><input type='text' id='ssid' name='ssid' required value='{SSID}'></div><div class='group'><label for='pass'>Password</label><input type='password' id='pass' name='pass' value='{PASS}'></div><div class='group'><label for='ep'>Endpoint API</label><input type='text' id='ep' name='ep' required value='{EP}'></div><button type='submit'>Salva</button></form></div></body></html>);
 html.replace({WIFI_LIST}, wifiListHtml);
 html.replace({SSID}, wifiSsid);
 html.replace({PASS}, wifiPass);
 html.replace({EP}, httpEndpoint);
 webServer.send(200, text/html, html);
 });

 webServer.on(/save, HTTP_POST, [&webServer]() {
 String ssid = webServer.arg(ssid); ssid.trim();
 String pass = webServer.arg(pass); pass.trim();
 String ep = webServer.arg(ep); ep.trim();
 if (ssid.length() > 0 && ep.length() > 0) {
 saveConfig(ssid, pass, ep);
 rtcWifi.crc32 = 0; writeRTCWifi();
 webServer.send(200, text/html, F(<!DOCTYPE html><html><body style='background:#0f172a;color:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;'><div style='text-align:center'><h2 style='color:#10b981'>Salvato!</h2><p>Il dispositivo si riavviera tra poco.</p></div></body></html>));
 { const uint32_t _t = millis(); while (millis() - _t < 2000UL) yield(); }
 ESP.restart();
 } else {
 webServer.send(400, text/plain, SSID e Endpoint obbligatori.);
 }
 });

 webServer.onNotFound([&webServer]() {
 String host = webServer.hostHeader();
 if (host == 192.168.4.1 || host.startsWith(192.168.4.1:)) webServer.send(404, text/plain, Not Found);
 else { webServer.sendHeader(Location, http://192.168.4.1/, true); webServer.send(302, text/plain, ); }
 });

 webServer.begin();
 DBG_PRINTLN(F([PORTAL] Portale avviato.));
 const uint32_t t_start = millis();
 while (millis() - t_start < 300000UL) { dnsServer.processNextRequest(); webServer.handleClient(); yield(); }

 display.ssd1306_command(CMD_CHARGEPUMP); display.ssd1306_command(CMD_PUMP_OFF); display.ssd1306_command(CMD_DISPLAYOFF);
 WiFi.mode(WIFI_OFF);
 DBG_PRINTLN(F([PORTAL] Timeout 5 min -- deepSleep...));
 ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED);
}

// =============================================================================
// LETTURA SENSORE SHT40 (I2C)
// =============================================================================
static bool readSensor(int16_t &t10, int16_t &h10) {
 Wire.begin(PIN_SDA_SHT, PIN_SCL_SHT);
 if (!sht4.begin(&Wire)) { DBG_PRINTLN(F([SHT40] ERR: init)); return false; }
 sht4.setPrecision(SHT4X_HIGH_PRECISION);
 sht4.setHeater(SHT4X_NO_HEATER);

 sensors_event_t hEv, tEv;
 if (!sht4.getEvent(&hEv, &tEv)) { DBG_PRINTLN(F([SHT40] ERR: lettura)); return false; }

 if (tEv.temperature < -40.0f || tEv.temperature > 125.0f ||
 hEv.relative_humidity < 0.0f || hEv.relative_humidity > 100.0f) {
 DBG_PRINTLN(F([SHT40] ERR: fuori range)); return false;
 }

 t10 = static_cast<int16_t>(tEv.temperature * 10.0f + 0.5f);
 h10 = static_cast<int16_t>(hEv.relative_humidity * 10.0f + 0.5f);
 // Fix Q4: abs() evita formato errato con temperatura negativa
 DBG_PRINTF([SHT40] T=%s%d.%d C  H=%d.%d%%\n,
 (t10 < 0 ? - : ), abs(t10)/10, abs(t10)%10, h10/10, h10%10);
 return true;
}

// =============================================================================
// DATA LOGGING SU LITTLEFS
// =============================================================================
static void saveMeasurement(int16_t t10, int16_t h10) {
 if (!LittleFS.begin()) { DBG_PRINTLN(F([FS] ERR: mount)); return; }
 File f = LittleFS.open(FPSTR(DATA_FILE), a);
 if (!f) { DBG_PRINTLN(F([FS] ERR: open)); LittleFS.end(); return; }
 if (f.size() < FS_MAX_BYTES) {
 f.print(t10); f.print(','); f.println(h10);
 DBG_PRINTF([FS] Dato accodato (file: %u byte)\n, (unsigned)f.size());
 } else {
 DBG_PRINTLN(F([FS] WARN: file pieno, dato scartato));
 }
 f.close(); LittleFS.end();
}

// =============================================================================
// TRASMISSIONE WI-FI
// =============================================================================
static void sendWiFiData() {
 DBG_PRINTLN(F([WiFi] Connessione...));
 WiFi.persistent(false); WiFi.mode(WIFI_STA);
 loadConfig();

 bool cacheValid = readRTCWifi();
 if (cacheValid) {
 DBG_PRINTF([WiFi] Cache valido (canale %d, BSSID %02X:%02X:%02X:%02X:%02X:%02X)\n,
 rtcWifi.channel, rtcWifi.bssid[0], rtcWifi.bssid[1], rtcWifi.bssid[2],
 rtcWifi.bssid[3], rtcWifi.bssid[4], rtcWifi.bssid[5]);
 WiFi.begin(wifiSsid.c_str(), wifiPass.c_str(), rtcWifi.channel, rtcWifi.bssid);
 } else {
 DBG_PRINTLN(F([WiFi] Nessun cache, scansione completa...));
 WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
 }

 const uint32_t t0 = millis(); bool fallbackTried = false;
 while (WiFi.status() != WL_CONNECTED) {
 uint32_t el = millis() - t0;
 if (cacheValid && !fallbackTried && el >= 4000UL) {
 DBG_PRINTLN(F([WiFi] Cache timeout 4s, scansione completa...));
 WiFi.disconnect(); delay(50); WiFi.begin(wifiSsid.c_str(), wifiPass.c_str()); fallbackTried = true;
 }
 if (el >= WIFI_TIMEOUT_MS) { DBG_PRINTLN(F([WiFi] Timeout connessione)); wifiOff(); return; }
 yield();
 }
 DBG_PRINTF([WiFi] Connesso in %lu ms\n, millis() - t0);

 rtcWifi.channel = WiFi.channel(); memcpy(rtcWifi.bssid, WiFi.BSSID(), 6); rtcWifi.padding = 0;
 writeRTCWifi();
 DBG_PRINTF([WiFi] Cache Wi-Fi aggiornato (Canale %d)\n, rtcWifi.channel);

 if (!LittleFS.begin()) { DBG_PRINTLN(F([FS] ERR: mount per invio)); wifiOff(); return; }
 File f = LittleFS.open(FPSTR(DATA_FILE), r);
 if (!f || f.size() == 0) {
 DBG_PRINTLN(F([FS] Nessun dato da inviare));
 if (f) f.close(); LittleFS.end(); wifiOff(); return;
 }
 DBG_PRINTF([WiFi] Invio %u byte di dati...\n, (unsigned)f.size());
 DBG_PRINTF([WiFi] Heap libero: %u byte\n, ESP.getFreeHeap());

 WiFiClientSecure client;
 // NOTA SICUREZZA: setInsecure() disabilita la verifica del certificato TLS (no CA check).
 // Accettabile per dispositivo IoT privato.
 client.setInsecure();
 // Buffer rx 16KB (catena certificati Cloudflare/Vercel), tx 512 byte.
 // Risparmia ~15KB di heap rispetto al default (16KB+16KB).
 client.setBufferSizes(16384, 512);
 HTTPClient http;
 http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
 http.setTimeout(10000);
 bool sendOk = false;

 if (http.begin(client, httpEndpoint)) {
 http.addHeader(F(Content-Type), F(text/csv));
 http.addHeader(F(X-Device-ID), WiFi.macAddress());
 // Fix B4: snprintf per sicurezza buffer; cast esplicito a unsigned
 char intervalStr[16];
 snprintf(intervalStr, sizeof(intervalStr), %u, (unsigned)(SLEEP_US / 1000000ULL));
 http.addHeader(F(X-Reading-Interval), intervalStr);
 DBG_PRINTF([WiFi] Heap prima di sendRequest: %u byte\n, ESP.getFreeHeap());
 const int code = http.sendRequest(POST, &f, f.size());
 DBG_PRINTF([HTTP] Risposta: %d\n, code);
 if (code < 0) {
 DBG_PRINTF([HTTP] Errore: %s\n, http.errorToString(code).c_str());
 char eb[100]; int e = client.getLastSSLError(eb, sizeof(eb));
 if (e) DBG_PRINTF([SSL] Error Code: %d - %s\n, e, eb);
 }
 sendOk = (code >= 200 && code < 300);
 http.end();
 } else { DBG_PRINTLN(F([HTTP] ERR: begin())); }

 f.close(); LittleFS.end();

 if (sendOk) {
 LittleFS.begin(); LittleFS.remove(FPSTR(DATA_FILE)); LittleFS.end();
 rtcCounter.counter = 0; writeRTC(); writeRTCRfPrepared(0);
 DBG_PRINTLN(F([WiFi] OK -- file eliminato, counter azzerato));
 } else {
 DBG_PRINTLN(F([WiFi] FAIL -- dati conservati per prossimo invio));
 }
 wifiOff();
}

// Mostra un messaggio di errore sul display per ~3s poi lo spegne.
// Fix B1: yield-loop invece di delay(3000) per non bloccare il watchdog.
static void showError() {
 Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
 if (!display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) && !display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) return;
 display.clearDisplay(); display.fillRect(0,0,128,14,SSD1306_WHITE);
 display.setTextColor(SSD1306_BLACK); display.setCursor(22,3); display.print(F([  ERRORE  ]));
 display.setTextColor(SSD1306_WHITE); display.setTextSize(2); display.setCursor(34,18); display.print(F(ERRORE));
 display.display();
 // Yield-loop da 3 secondi: non blocca il watchdog hardware
 { const uint32_t _t = millis(); while (millis() - _t < 3000UL) yield(); }
 display.ssd1306_command(CMD_CHARGEPUMP); display.ssd1306_command(CMD_PUMP_OFF); display.ssd1306_command(CMD_DISPLAYOFF);
}

// =============================================================================
// DISPLAY DATI LIVE
// =============================================================================
static void runDisplayCycle(uint32_t durationMs = 10000UL) {
 Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
 if (!display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) && !display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
 DBG_PRINTLN(F([OLED] ERR: init fallita)); return;
 }
 DBG_PRINTF([OLED] Avvio ciclo display %lu ms\n, durationMs);
 // M5: scrivi il flag RTC UNA SOLA VOLTA prima del loop (non ad ogni iterazione ~1s)
 writeRTCFlag(MAGIC_CONFIG_PORTAL);

 uint32_t t0 = millis();
 while (millis() - t0 < durationMs) {
 int16_t t10 = 0, h10 = 0;
 if (readSensor(t10, h10)) {
 Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
 display.clearDisplay();
 display.fillRect(0, 0, 128, 16, SSD1306_WHITE);
 display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(22, 4);
 display.print(F(CLIMA AMBIENTE));
 display.setTextColor(SSD1306_WHITE);

 char tempStr[10], humStr[10];
 if (t10 < 0) snprintf(tempStr, sizeof(tempStr), -%d.%d\xF8"C, abs(t10)/10, abs(t10)%10);
      else          snprintf(tempStr, sizeof(tempStr), %d.%d\xF8C,  t10/10, t10%10);
      snprintf(humStr, sizeof(humStr), %d.%d%% RH, h10/10, h10%10);

      display.setTextSize(3);
      display.setCursor((128 - (int)(strlen(tempStr)*18))/2, 17);
      display.print(tempStr);
      display.setTextSize(2);
      display.setCursor((128 - (int)(strlen(humStr)*12))/2, 41);
      display.print(humStr);
      display.setTextSize(1); display.setCursor(16, 57); display.print(F(RESET per Config));
      display.display();
    }
    uint32_t ds = millis(); while (millis() - ds < 1000UL) yield();
  }

  writeRTCFlag(0);
  display.ssd1306_command(CMD_CHARGEPUMP); display.ssd1306_command(CMD_PUMP_OFF); display.ssd1306_command(CMD_DISPLAYOFF);
  DBG_PRINTLN(F([OLED] Display spento -- standby));
}

// =============================================================================
//  SETUP E LOOP
// =============================================================================
void setup() {
  // 1. LETTURA IMMEDIATA STATO RTC (ottimizzazione doppio click ultra-veloce)
  const bool autoWake = isDeepSleepWake();
  readRTCFlag();

  bool enterConfigPortal  = false;
  bool enterConfigConfirm = false;
  bool enterDisplayCycle  = false;
  bool isFirstManualReset = false;

  if (!autoWake) {
    if (rtcFlagWord == MAGIC_AWAIT) {
      enterDisplayCycle = true;
      writeRTCFlag(0);
    } else if (rtcFlagWord == MAGIC_CONFIG_PORTAL) {
      enterConfigConfirm = true;
      writeRTCFlag(0);
    } else if (rtcFlagWord == MAGIC_CONFIG_CONFIRM) {
      enterConfigPortal = true;
      writeRTCFlag(0);
    } else {
      // E un reset manuale e non ci sono flag in attesa.
      // SCRIVIAMO SUBITO IL FLAG MAGIC_AWAIT!
      writeRTCFlag(MAGIC_AWAIT);
      isFirstManualReset = true;
    }
  } else {
    // Se e un risveglio automatico, pulisce i flag sporchi
    if (rtcFlagWord != 0) writeRTCFlag(0);
  }

  // 2. RIPRISTINO HARDWARE (lento, dopo aver salvato il flag RTC)
  recoverI2C(PIN_SDA_SHT, PIN_SCL_SHT);
  recoverI2C(PIN_SDA_OLED, PIN_SCL_OLED);
  readRTCRfPrepared();

  // Spegni la radio subito se non e un invio programmato
  if (!(autoWake && rtcRfPrepared == 1)) { WiFi.mode(WIFI_OFF); WiFi.forceSleepBegin(); }

  DBG_BEGIN(115200);
  DBG_PRINTLN(F(\n[BOOT] Termoigrometro ESP8266 v2.0));

  // Inizializza contatore in RAM RTC
  if (!readRTC()) {
    DBG_PRINTLN(F([RTC] CRC invalido -- primo avvio, contatore azzerato));
    rtcCounter.counter = 0; writeRTC();
  }
  // Fix B1: reset a 0 (non a READINGS_PER_SEND) per evitare invio immediato con file vuoto.
  if (rtcCounter.counter > 10000u) rtcCounter.counter = 0;
  DBG_PRINTF([RTC] Contatore: %lu / %u\n, rtcCounter.counter, READINGS_PER_SEND);

  if (!autoWake && rtcRfPrepared != 0) writeRTCRfPrepared(0);
  DBG_PRINTF([BOOT] Modalita: %s | SDK: %s\n, autoWake ? AUTO : MANUALE, ESP.getResetReason().c_str());

  if      (enterDisplayCycle)  DBG_PRINTLN(F([BOOT] *** Secondo Reset: attivo display! ***));
  else if (enterConfigConfirm) DBG_PRINTLN(F([BOOT] *** Reset display: conferma Config Portal ***));
  else if (enterConfigPortal)  DBG_PRINTLN(F([BOOT] *** Reset confermato: entro Config Portal! ***));

  // Gestione primo reset manuale: standby silenzioso per attendere il secondo reset
  if (isFirstManualReset) {
    DBG_PRINTLN(F([BOOT] Primo Reset. Standby 2s per rilevare secondo reset...));
    const uint32_t t_win = millis();
    while (millis() - t_win < DISPLAY_WIN_MS) yield();
    writeRTCFlag(0); WiFi.mode(WIFI_OFF);
    DBG_PRINTLN(F([BOOT] Timeout -- deepSleep...));
    ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED); return;
  }

  // Logica conferma configurazione portale
  if (enterConfigConfirm) {
    Wire.begin(PIN_SDA_OLED, PIN_SCL_OLED);
    if (display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) || display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
      display.clearDisplay(); display.fillRect(0,0,128,14,SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK); display.setTextSize(1); display.setCursor(26,3); display.print(F(CONFIGURAZIONE));
      display.setTextColor(SSD1306_WHITE);
      display.setCursor(16,24); display.print(F(Premi RESET ora));
      display.setCursor(22,36); display.print(F(per confermare));
      display.fillRect(14,52,100,2,SSD1306_WHITE);
      display.display();
    }
    writeRTCFlag(MAGIC_CONFIG_CONFIRM);
    const uint32_t t_win = millis(); while (millis() - t_win < 5000UL) yield();
    writeRTCFlag(0);
    display.ssd1306_command(CMD_CHARGEPUMP); display.ssd1306_command(CMD_PUMP_OFF); display.ssd1306_command(CMD_DISPLAYOFF);
    WiFi.mode(WIFI_OFF);
    DBG_PRINTLN(F([BOOT] Conferma scaduta -- deepSleep...));
    ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED); return;
  }

  if (enterConfigPortal) { runWifiPortal(); }

  // Risveglio RF_DEFAULT: invio immediato dati accumulati
  if (autoWake && rtcRfPrepared == 1) {
    DBG_PRINTLN(F([AUTO] Risveglio RF_DEFAULT per invio dati...));
    WiFi.forceSleepWake(); delay(1);
    sendWiFiData();
    uint32_t elMs = millis(); uint64_t slMs = SLEEP_US / 1000ULL;
    // Fix B2: se elapsed >= sleepMs il ciclo e gia in ritardo -> sleep 0 (risveglio immediato)
    uint64_t actUs = (slMs > (uint64_t)elMs) ? (slMs - (uint64_t)elMs) * 1000ULL : 0ULL;
    DBG_PRINTF([BOOT] -> deepSleep %llu s (sveglio %lu ms)\n, actUs / 1000000ULL, elMs);
    ESP.deepSleep(actUs, WAKE_RF_DISABLED); return;
  }

  // Lettura sensore SHT40 reale
  int16_t t10 = 0, h10 = 0;
  if (!readSensor(t10, h10)) {
    DBG_PRINTLN(F([ERR] Sensore SHT40 -- mostro errore su display, poi sleep));
    writeRTCFlag(0);
    showError();
    ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED); return;
  }

  if (autoWake) {
    // Ciclo automatico: salva dato e controlla soglia invio
    saveMeasurement(t10, h10);
    ++rtcCounter.counter; writeRTC();
    DBG_PRINTF([RTC] Aggiornato: %lu\n, rtcCounter.counter);

    if (rtcCounter.counter >= READINGS_PER_SEND) {
      DBG_PRINTLN(F([AUTO] Soglia raggiunta -- riavvio con RF_DEFAULT per invio...));
      writeRTCRfPrepared(1);
      ESP.deepSleep(10000ULL, WAKE_RF_DEFAULT); return;
    } else {
      if (rtcRfPrepared != 0) writeRTCRfPrepared(0);
      DBG_PRINTF([AUTO] %lu/%u -- sleep RF_OFF\n, rtcCounter.counter, READINGS_PER_SEND);
    }
  } else {
    // Ciclo manuale (secondo reset confermato): SOLO VISUALIZZAZIONE, nessun dato salvato.
    DBG_PRINTLN(F([MAN] Ciclo Display 10s (SOLO VISUALIZZAZIONE)));
    runDisplayCycle(10000UL);
  }

  uint32_t elMs = millis(); uint64_t slMs = SLEEP_US / 1000ULL;
  // Fix B2b: se elapsed >= sleepMs il ciclo e gia in ritardo -> sleep 0
  uint64_t actUs = (slMs > (uint64_t)elMs) ? (slMs - (uint64_t)elMs) * 1000ULL : 0ULL;
  DBG_PRINTF([BOOT] -> deepSleep %llu s (sveglio %lu ms)\n, actUs / 1000000ULL, elMs);
  ESP.deepSleep(actUs, WAKE_RF_DISABLED);
}

void loop() { ESP.deepSleep(SLEEP_US, WAKE_RF_DISABLED); }
