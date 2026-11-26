// Heartbeat test: an unchanged rebuild keeps the index file and generation but refreshes manifest.verifiedAt.
const fs = require('fs'), path = require('path'), cp = require('child_process'); const { makeDataset } = require('./lib/mockdata'); const { createMock } = require('./lib/mocksite');
const root = path.resolve(__dirname, '..'); const out = path.join(root, 'qa', 'heartbeat');
const build = base => new Promise(res => { const p = cp.spawn(process.execPath, [path.join(root, 'builder', 'build_index.js'), '--base', base, '--out', out, '--pace', '0'], { stdio: 'ignore' }); p.on('close', c => res(c)); });
const man = () => JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')); const R = []; const rec = (n, ok, d) => { R.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' :: ' + d : '')); };
(async () => { fs.rmSync(out, { recursive: true, force: true }); const m = createMock(makeDataset(20, 5)); const base = await m.listen();
  rec('H1 first build exits 0', await build(base) === 0); const a = man(); rec('H2 manifest has generation and verifiedAt', !!a.generation && !!a.verifiedAt);
  await new Promise(r => setTimeout(r, 1100)); rec('H3 unchanged rebuild exits 0', await build(base) === 0); const b = man();
  rec('H4 index file and generation unchanged', a.file === b.file && a.generation === b.generation && a.sha256 === b.sha256);
  rec('H5 verifiedAt advanced', Date.parse(b.verifiedAt) > Date.parse(a.verifiedAt), a.verifiedAt + ' -> ' + b.verifiedAt);
  rec('H6 index file still intact', JSON.parse(fs.readFileSync(path.join(out, b.file), 'utf8')).v === 2); await m.close();
  console.log('FAILS', R.filter(x => !x).length); process.exitCode = R.every(Boolean) ? 0 : 1; })();
