/*
  Drive uploader for the first-off card's attachments.

  Setup (once):
   1. Go to script.google.com, create a new project and paste this file in.
   2. Project Settings > Script properties, add:
        SECRET     any long random text (the same value goes in drive-config.js)
        FOLDER_ID  the id of the machine shop's Drive folder (the part of the
                   folder's URL after /folders/)
   3. Deploy > New deployment > type Web app
        Execute as: Me
        Who has access: Anyone
      Copy the web app URL into drive-config.js as DRIVE_UPLOAD_URL.
   4. Run doPost once from the editor if asked, and approve Drive access.

  Each work order gets its own subfolder inside that folder. Re-deploy a new
  version (Deploy > Manage deployments > Edit) after changing this file.
*/

function doPost(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var body = JSON.parse(e.postData.contents);
    if (body.secret !== props.getProperty("SECRET")) return reply({ ok: false, error: "Not allowed" });

    var root = DriveApp.getFolderById(props.getProperty("FOLDER_ID"));
    var folderName = String(body.folder || "Unsorted");
    var matches = root.getFoldersByName(folderName);
    var folder = matches.hasNext() ? matches.next() : root.createFolder(folderName);

    var blob = Utilities.newBlob(Utilities.base64Decode(body.data), body.mimeType, body.name);
    var file = folder.createFile(blob);
    return reply({ ok: true, id: file.getId(), url: file.getUrl() });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
