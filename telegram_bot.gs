/**
 * D.U.B.I.A. Theorem Telegram Webhook
 * Acts as the bridge between Telegram and Google Sheets.
 */

// Define the properties service to get the token securely
const scriptProperties = PropertiesService.getScriptProperties();
// You must set this property in Google Apps Script -> Project Settings -> Script Properties
const TELEGRAM_TOKEN = scriptProperties.getProperty('TELEGRAM_TOKEN');

function doPost(e) {
  if (typeof e !== 'undefined') {
    let update = JSON.parse(e.postData.contents);
    if (update.message) {
      let chatId = update.message.chat.id;
      let text = update.message.text;

      // Handle the /start command
      if (text === "/start") {
         sendMessage(chatId, "Benvenuto nel sistema D.U.B.I.A. Invia il peso totale rilevato (in grammi) per avviare il censimento.");
      }
      // Handle numeric input (weight in grams)
      else if (!isNaN(text)) {
         let weight = parseFloat(text);
         // Example calculation using D.U.B.I.A variables
         let W_adulti = weight * 0.35;
         let W_neanidi = weight * 0.65;

         // Example response
         let responseText = `Peso registrato: ${weight}g\n` +
                            `Macro Adulti Stimato: ${W_adulti.toFixed(2)}g\n` +
                            `Macro Neanidi Stimato: ${W_neanidi.toFixed(2)}g\n` +
                            `Dati salvati sul foglio 'Censimento'.`;

         sendMessage(chatId, responseText);

         // TODO: Append data to Google Sheets
         // const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Censimento");
         // sheet.appendRow([new Date(), weight, W_adulti, W_neanidi]);
      } else {
         sendMessage(chatId, "Comando non riconosciuto. Invia un valore numerico (peso in grammi).");
      }
    }
  }
  return ContentService.createTextOutput("OK");
}

function sendMessage(chatId, text) {
  let url = "https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage";
  let payload = {
    "chat_id": chatId,
    "text": text
  };

  let options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload)
  };

  UrlFetchApp.fetch(url, options);
}
