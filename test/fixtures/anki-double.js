// A local AnkiConnect, answering the way its plugin/__init__.py does: same
// actions, same error strings, version 6 required on every call, `multi`
// unwrapped, a picture read off disk as the real add-on reads it. Used by the
// client's unit suite and by the screen suite's end-to-end run.
//
// The note type is a property of the collection this pretends to be, not of
// the client, so it is written here rather than imported: requiring
// app/main/anki.js would also require log.js, which hooks the console and
// mirrors whatever the caller prints into the app's log.

const fs = require('fs');
const http = require('http');

const MODEL = 'Lapis';

/**
 * What plugin/__init__.py answers, for the actions the client uses. It also
 * serves `lapis` under /lapis/, standing in for GitHub's raw host.
 */
function ankiDouble() {
  const notes = new Map();   // id -> {deck, fields, tags, picture}
  const models = ['Basic', MODEL];
  const created = [];        // createModel's params, as received
  const lapis = {};          // file name -> body served under /lapis/
  let nextId = 1000;
  const log = [];
  const one = (req) => {
    log.push(req);
    const p = req.params || {};
    if (req.version !== 6) throw new Error('version 6 expected on every action');
    switch (req.action) {
      case 'version': return 6;
      case 'modelNames': return models.slice();
      case 'deckNames': return ['Default', 'Mining', 'Mining::Novels'];
      case 'findNotes': {
        const m = /^"deck:(.+?)" "note:Lapis" "expression:(.+)"$/.exec(p.query);
        if (!m) throw new Error('query shape: ' + p.query);
        const unescape = (s) => s.replace(/\\(.)/g, '$1');
        const deck = unescape(m[1]), expr = unescape(m[2]);
        return [...notes].filter(([, n]) => n.deck === deck && n.fields.Expression === expr)
          .map(([id]) => id);
      }
      case 'addNote': {
        const n = p.note;
        if (!models.includes(n.modelName)) {
          throw new Error(`model was not found: ${n.modelName}`);
        }
        if (!['Default', 'Mining', 'Mining::Novels'].includes(n.deckName)) {
          throw new Error(`deck was not found: ${n.deckName}`);
        }
        if (!n.fields.Expression) throw new Error('cannot create note because it is empty');
        const dup = [...notes.values()].some((x) =>
          x.deck === n.deckName && x.fields.Expression === n.fields.Expression);
        if (dup && !n.options.allowDuplicate) {
          throw new Error('cannot create note because it is a duplicate');
        }
        const picture = (n.picture || []).map((pic) => ({
          filename: pic.filename, fields: pic.fields, bytes: fs.readFileSync(pic.path),
        }));
        const id = ++nextId;
        notes.set(id, { deck: n.deckName, fields: n.fields, tags: n.tags, picture });
        return id;
      }
      case 'createModel':
        if (models.includes(p.modelName)) throw new Error('Model name already exists');
        created.push(p);
        models.push(p.modelName);
        return { name: p.modelName };
      case 'deleteNotes':
        for (const id of p.notes) notes.delete(id);
        return null;
      case 'multi':
        return p.actions.map((a) => {
          try { return { result: one(a), error: null }; }
          catch (e) { return { result: null, error: e.message }; }
        });
      default: throw new Error('unsupported action');
    }
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      const name = req.url.replace(/^\/lapis\//, '');
      if (!(name in lapis)) { res.statusCode = 404; res.end(); return; }
      res.end(lapis[name]);
      return;
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let out;
      try { out = { result: one(JSON.parse(body)), error: null }; }
      catch (e) { out = { result: null, error: e.message }; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  return { server, notes, log, models, created, lapis };
}

module.exports = { ankiDouble };
