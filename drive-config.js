/* Where first-off attachments are uploaded: the Google Apps Script web app
   (apps-script/drive-upload.gs) and the secret set in its script properties.
   Leave the URL blank to switch attachments off - the Attach buttons then say
   Drive isn't connected.

   Parked: Dexory's Google Workspace only allows the uploader for signed-in
   Dexory users, so a no-sign-in upload from the app can't reach it. */

export const DRIVE_UPLOAD_URL = "";
export const DRIVE_UPLOAD_SECRET = "";

/* The Drive folders the "Save to Drive" buttons open after downloading a PDF.
   The app can't write into Drive on its own (see above), so the button
   downloads the PDF and opens the folder, ready to drag it in. These are plain
   folder links: only people with access to the folder can open them. */
export const ROUTE_CARD_FOLDER_URL = "https://drive.google.com/drive/folders/1VQatwvSqsOobRx-PdDm77VN7vglYPlJy";
export const IDN_FOLDER_URL = "https://drive.google.com/drive/folders/1hN9nYcrX_yawLQTMV0S95dzm-ae6Fa3U";
