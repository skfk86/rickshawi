// ينسخ المكتبات من node_modules إلى www/lib (بدون bundler)
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, '..', 'www', 'lib');
fs.mkdirSync(out, { recursive: true });
const nm = (p) => path.join(__dirname, '..', 'node_modules', p);
const files = [
  ['@supabase/supabase-js/dist/umd/supabase.js', 'supabase.js'],
  ['leaflet/dist/leaflet.js', 'leaflet.js'],
  ['leaflet/dist/leaflet.css', 'leaflet.css']
];
for (const [src, dst] of files) { fs.copyFileSync(nm(src), path.join(out, dst)); console.log('✓', dst); }
fs.cpSync(nm('leaflet/dist/images'), path.join(out, 'images'), { recursive: true });
