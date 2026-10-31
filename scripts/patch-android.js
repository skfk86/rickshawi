// يضيف صلاحيات الموقع والاسم العربي لمشروع أندرويد بعد `cap add android`
const fs = require('fs'), path = require('path');
const mf = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
let x = fs.readFileSync(mf, 'utf8');
const perms = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.VIBRATE',
  'android.permission.ACCESS_NETWORK_STATE'
];
for (const p of perms) if (!x.includes(p)) x = x.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
if (!x.includes('android.hardware.location.gps')) x = x.replace('</manifest>', '    <uses-feature android:name="android.hardware.location.gps" android:required="false" />\n</manifest>');
if (!x.includes('<queries>')) x = x.replace('</manifest>', `    <queries>
        <intent><action android:name="android.intent.action.DIAL" /></intent>
        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="https" /></intent>
        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="geo" /></intent>
    </queries>\n</manifest>`);
fs.writeFileSync(mf, x);
console.log('✓ AndroidManifest patched');
