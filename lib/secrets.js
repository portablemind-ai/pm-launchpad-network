'use strict';

// Per-workspace secret store.
//
// These secrets exist per accelerator and ALL of them are per workspace (guide §7.3):
//   provisioning_key   the API key (built-in `provisioner` role) that creates founder accounts
//   sso_key            the white-label sign-on key (guide §7.4) — can sign in as ANYONE there
//   invite_code        the code a founder must present to sign up
//   forms_key          API key (role lp_forms_writer) that reads/writes founder-form records
//   forms_key_id       its id, so a replacement can switch the old one off
//
// They never reach the browser and are never logged. This implementation is an AES-256-GCM
// encrypted JSON file, which is enough for a reference app; in production put the same interface
// in front of your cloud secret manager.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FIELDS = new Set(['provisioning_key', 'provisioning_key_id', 'sso_key', 'invite_code', 'forms_key', 'forms_key_id']);

function createSecretStore({ dataDir, key }) {
  const file = path.join(dataDir, 'secrets.enc');
  let cache = null;

  function readAll() {
    if (cache) return cache;
    if (!fs.existsSync(file)) return (cache = {});
    const raw = fs.readFileSync(file);
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    cache = JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
    return cache;
  }

  function writeAll(obj) {
    fs.mkdirSync(dataDir, { recursive: true });
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), data]), { mode: 0o600 });
    fs.renameSync(tmp, file);
    cache = obj;
  }

  return {
    get(workspace, field) {
      const ws = readAll()[workspace];
      return (ws && ws[field]) || '';
    },
    set(workspace, field, value) {
      if (!FIELDS.has(field)) throw new Error(`unknown secret field ${field}`);
      const all = { ...readAll() };
      all[workspace] = { ...(all[workspace] || {}), [field]: String(value) };
      writeAll(all);
    },
    remove(workspace, field) {
      const all = { ...readAll() };
      if (!all[workspace]) return;
      if (field) { const ws = { ...all[workspace] }; delete ws[field]; all[workspace] = ws; } else delete all[workspace];
      writeAll(all);
    },
    // Which secrets a workspace holds — booleans only, safe to show an admin.
    presence(workspace) {
      const ws = readAll()[workspace] || {};
      return { provisioning_key: !!ws.provisioning_key, sso_key: !!ws.sso_key, invite_code: !!ws.invite_code };
    },
    workspaces() { return Object.keys(readAll()); },
  };
}

module.exports = { createSecretStore };
