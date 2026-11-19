/* Where first-off attachments are uploaded: the Google Apps Script web app
   (apps-script/drive-upload.gs) and the secret set in its script properties.
   Leave the URL blank to switch attachments off - the Attach buttons then say
   Drive isn't connected.

   Parked: Dexory's Google Workspace only allows the uploader for signed-in
   Dexory users, so a no-sign-in upload from the app can't reach it. */

export const DRIVE_UPLOAD_URL = "";
export const DRIVE_UPLOAD_SECRET = "";
