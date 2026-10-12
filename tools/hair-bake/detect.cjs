// Face landmarks, the facial transformation matrix and the hair confidence mask for still
// images, from the site's own vendored MediaPipe (the same models app.js runs), in headless
// Chromium.  Used by the bake's self-test and by qa.py to place sprites on test portraits.
//
//   node tools/hair-bake/detect.cjs --out <dir> image.png [image2.jpg ...]
//
// Needs the local site server (node tools/preview.cjs, http://127.0.0.1:4173).
// For each image writes <dir>/<name>.json:
//   {w, h, landmarks: [{x, y, z} x 478] (normalised like app.js receives them, or null),
//    matrix: [16] (MediaPipe's facialTransformationMatrixes[0].data, as face-core.js forwards it),
//    mw, mh}
// and <dir>/<name>.hair.png (hair confidence 0..255 at the segmenter's own resolution).
// One browser, closed at the end; images that are already done are skipped unless --force.
const fs = require('fs'), path = require('path');
const {chromium} = require('/opt/node22/lib/node_modules/playwright');

(async () => {
  const args = process.argv.slice(2);
  let out = null, force = false, base = 'http://127.0.0.1:4173';
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--force') force = true;
    else if (args[i] === '--base') base = args[++i];
    else files.push(args[i]);
  }
  if (!out || !files.length) { console.error('usage: detect.cjs --out <dir> images...'); process.exit(2); }
  fs.mkdirSync(out, {recursive: true});
  const todo = files.filter(f => force || !fs.existsSync(path.join(out, path.parse(f).name + '.json')));
  if (!todo.length) { console.log('all done'); return; }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(base + '/robots.txt');
    await page.evaluate(async () => {
      const V = await import('/vendor/vision_bundle.mjs');
      const fs = await V.FilesetResolver.forVisionTasks('/vendor/wasm');
      window.lm = await V.FaceLandmarker.createFromOptions(fs, {baseOptions: {modelAssetPath: '/vendor/face_landmarker.task'},
        runningMode: 'IMAGE', numFaces: 1, outputFacialTransformationMatrixes: true});
      window.seg = await V.ImageSegmenter.createFromOptions(fs, {baseOptions: {modelAssetPath: '/vendor/hair_segmenter.tflite'},
        runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false});
    });
    for (const file of todo) {
      const ext = path.extname(file).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const data = `data:${mime};base64,` + fs.readFileSync(file).toString('base64');
      const res = await page.evaluate(async (data) => {
        const img = new Image(); img.src = data; await img.decode();
        const r = window.lm.detect(img);
        const m4 = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0];
        const o = {w: img.naturalWidth, h: img.naturalHeight, landmarks: r.faceLandmarks[0] || null,
          matrix: m4 ? Array.from(m4.data) : null};
        const s = window.seg.segment(img);
        const m = s.confidenceMasks[s.confidenceMasks.length > 1 ? 1 : 0], mw = m.width, mh = m.height, f = m.getAsFloat32Array();
        const c = document.createElement('canvas'); c.width = mw; c.height = mh;
        const x = c.getContext('2d'), id = x.createImageData(mw, mh);
        for (let i = 0; i < f.length; i++) { const v = Math.round(f[i] * 255); id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
        x.putImageData(id, 0, 0); o.hair = c.toDataURL('image/png'); o.mw = mw; o.mh = mh;
        s.close && s.close();
        return o;
      }, data);
      const name = path.parse(file).name;
      fs.writeFileSync(path.join(out, name + '.hair.png'), Buffer.from(res.hair.split(',')[1], 'base64'));
      delete res.hair;
      if (res.landmarks) res.landmarks = res.landmarks.map(p => ({x: +p.x.toFixed(6), y: +p.y.toFixed(6), z: +p.z.toFixed(6)}));
      fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(res));
      console.log(name, res.landmarks ? res.landmarks.length + ' landmarks' : 'NO FACE', res.matrix ? 'matrix' : '', res.mw + 'x' + res.mh);
    }
  } finally {
    await browser.close();
  }
})();
