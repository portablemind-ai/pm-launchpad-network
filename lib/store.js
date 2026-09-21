'use strict';

// Non-secret application state, kept as one JSON file:
//   accelerators   the registry of this network's sub-workspaces: numeric id + identifier (+ name).
//                  Refreshed from GET /tenants whenever the network console loads. It is the ONLY
//                  thing that decides whether a sign-in to a non-network workspace is allowed.
//   pending        sub-workspaces we asked for that have not appeared yet (activation pending)
//   snapshots      stored metrics per accelerator (GET /tenants/:id/stats is heavy — guide §3.6)
//   transfers      an audit trail of token transfers this app made
//   channels       the startup team channel this app opened, per workspace:team

const fs = require('fs');
const path = require('path');

function createStore({ dataDir }) {
  const file = path.join(dataDir, 'state.json');
  let state = null;

  function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { state = {}; }
    state.accelerators ||= {}; state.pending ||= []; state.snapshots ||= {}; state.transfers ||= []; state.channels ||= {};
    return state;
  }
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(file + '.tmp', file);
  }

  return {
    get state() { return load(); },
    update(fn) { load(); const out = fn(state); save(); return out; },
    // Includes departed accelerators (callers check `departed_at`).
    acceleratorByIdentifier(identifier) {
      return Object.values(load().accelerators).find((a) => a.identifier === identifier) || null;
    },
    acceleratorById(id) { return load().accelerators[String(id)] || null; },
  };
}

module.exports = { createStore };
