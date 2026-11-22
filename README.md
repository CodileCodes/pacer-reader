# Pacer Reader

PDF reader for your phone: AI voice (Kokoro) or your phone's voice, Fast read mode, a library with covers,
and sync between devices through your own private GitHub repo.

This repository builds two things by itself every time you push:
1. The web app, published at `https://YOURNAME.github.io/THIS-REPO/`
2. An Android APK, attached to the **Releases** page as `pacer-reader.apk`

## One-time setup (about 10 minutes)

### A. Put this code on GitHub and publish it
1. On github.com click **New repository**. Name it `pacer-reader`. Public is simplest (GitHub Pages is free for public repos). Do not add a README.
2. Upload everything in this folder: on the new repo page click **uploading an existing file**, drag in all files and folders (including the hidden `.github` folder), then **Commit changes**.
   If drag and drop skips `.github`, add the file `.github/workflows/deploy.yml` with **Add file > Create new file** and paste its contents.
3. Go to **Settings > Pages**. Under **Source** choose **GitHub Actions**.
4. Go to the **Actions** tab and wait for "Build web app and Android APK" to turn green (the APK job takes about 5 to 8 minutes).
5. Your web app: `https://YOURNAME.github.io/pacer-reader/`. Your APK: the repo's **Releases** page, file `pacer-reader.apk`.

### B. Install on your phone
- **Web app:** open the link in Chrome, menu, **Install app**.
- **APK:** download `pacer-reader.apk` from Releases on your phone, open it, allow "install from this source" when Android asks.
  (It is a debug-signed build for personal use, so Play Protect may warn you. That is expected.)

### C. Turn on sync (private)
Your books and reading position are stored in a separate **private** repository that only you can read.
1. New repository, name it `pacer-sync`, set it to **Private**, tick "Add a README" (so it is not empty).
2. github.com > your avatar > **Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token**.
   - Repository access: **Only select repositories**, choose `pacer-sync`.
   - Permissions: **Contents: Read and write**.
   - Copy the token (starts with `github_pat_`).
3. In the app: **Settings > Sync between devices**. Repository `YOURNAME/pacer-sync`, paste the token, **Connect and sync**.
4. Do the same on every device (web page and APK). Books, progress, masks and settings follow you.

## Using the AI voice
Settings > Voice engine > AI voice. The first time you press play it asks to download about 90 MB. After that it is kept on the device and works offline.

## Limits
- Text PDFs only. No OCR on the phone.
- PDF files over about 45 MB are not synced (GitHub API limit). Everything else about them still syncs.
- The AI voice runs on the phone's processor. A recent phone keeps up at normal speed. An old phone may pause between sentences. Lower the speed or switch to the phone voice.
- Sound may stop when the screen locks. Keep the screen on while listening.
- The token is stored in the app on each device. Use a token limited to the sync repo only, as in step C.
