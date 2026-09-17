# Signing credentials — NEVER committed

Everything in this directory except this README is gitignored:

- `mas_key.key` — the private key behind the distribution certificates.
  SECRET. Anyone holding it can sign software as this team. It exists on
  disk only as a backup; the working copy lives in the login Keychain.
- `mac_app.cer`, `mac_installer.cer` — public certificates, re-downloadable
  from developer.apple.com at any time.
- `Yomi_Overlay_MAS.provisionprofile` — the Mac App Store provisioning
  profile. Not secret, but team-specific and it expires; regenerate on the
  portal rather than sharing it.

tools/mas/install.sh looks for the provisioning profile here.
