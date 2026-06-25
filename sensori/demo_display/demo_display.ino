/*
 * DEMO DISPLAY OLED - Termoigrometro
 * Questo sketch serve solo a mostrare come verranno visualizzate
 * le temperature e l'umidità sul display OLED integrato.
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// Pin I2C per la scheda AITEXM ESP8266 con OLED integrato
static constexpr uint8_t PIN_SDA = 14; // D5
static constexpr uint8_t PIN_SCL = 12; // D6

static constexpr uint8_t SCREEN_W = 128;
static constexpr uint8_t SCREEN_H = 64;
static constexpr uint8_t DISP_PRI = 0x3C;
static constexpr uint8_t DISP_FALL = 0x3D;

static Adafruit_SSD1306 display(SCREEN_W, SCREEN_H, &Wire, -1);

// =============================================================================
//  DISPLAY UX DESIGN — Ottimizzato per OLED Bicolore (16px Gialli / 48px Azzurri)
// =============================================================================
void showDisplay(int16_t t10, int16_t h10) {
  display.clearDisplay();

  // ── 1. HEADER (Zona Gialla: y = 0 a 15) ──────────────────────────────────
  // Creiamo una barra solida gialla con testo nero (stile "Status Bar")
  display.fillRect(0, 0, 128, 16, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1); // Testo 6x8 px
  // Centriamo "CLIMA AMBIENTE" (14 char * 6px = 84px → x = 22)
  display.setCursor(22, 4); // y=4 per centrare verticalmente nei 16px
  display.print(F("CLIMA AMBIENTE"));

  // ── 2. DATI (Zona Azzurra: y = 16 a 63) ──────────────────────────────────
  display.setTextColor(SSD1306_WHITE);

  // Buffer per formattare le stringhe e calcolare l'offset per centrarle
  char tempStr[10];
  char humStr[10];

  // Gestione segno e conversione in stringa per la temperatura
  if (t10 < 0) {
    sprintf(tempStr, "-%d.%d\xF8" "C", (-t10) / 10, (-t10) % 10);
  } else {
    sprintf(tempStr, "%d.%d\xF8" "C", t10 / 10, t10 % 10);
  }
  
  // Conversione umidità
  sprintf(humStr, "%d.%d%% RH", h10 / 10, h10 % 10);

  // --- Temperatura (TextSize 3: 18x24 px) ---
  display.setTextSize(3);
  int tempLen = strlen(tempStr);
  int tempWidth = tempLen * 18; // larghezza in pixel
  int tempX = (128 - tempWidth) / 2;
  display.setCursor(tempX, 22); // y=22 lascia un margine dalla zona gialla
  display.print(tempStr);

  // --- Umidita (TextSize 2: 12x16 px) ---
  display.setTextSize(2);
  int humLen = strlen(humStr);
  int humWidth = humLen * 12; // larghezza in pixel
  int humX = (128 - humWidth) / 2;
  display.setCursor(humX, 48); // y=48 lascia spazio dalla temperatura
  display.print(humStr);

  display.display();
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n[DEMO] Avvio test display OLED...");

  // Inizializza I2C con i pin corretti
  Wire.begin(PIN_SDA, PIN_SCL);

  // Inizializza il display
  if (!display.begin(SSD1306_SWITCHCAPVCC, DISP_PRI) &&
      !display.begin(SSD1306_SWITCHCAPVCC, DISP_FALL)) {
    Serial.println("[ERR] Display OLED non trovato!");
    for (;;); // Blocca qui se non trova il display
  }
  
  Serial.println("[OK] Display inizializzato. Inizio ciclo demo.");
}

void loop() {
  // Demo 1: Valori normali da casa
  // 23.5 °C (235) e 45.2 % RH (452)
  showDisplay(235, 452);
  delay(3000);

  // Demo 2: Molto caldo e umido
  // 35.0 °C (350) e 80.5 % RH (805)
  showDisplay(350, 805);
  delay(3000);

  // Demo 3: Freddo (valori negativi)
  // -4.2 °C (-42) e 30.0 % RH (300)
  showDisplay(-42, 300);
  delay(3000);
  
  // Demo 4: Esattamente zero
  // 0.0 °C (0) e 55.5 % RH (555)
  showDisplay(0, 555);
  delay(3000);
}
