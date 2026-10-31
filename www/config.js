// إعدادات ركشتي — المفتاح ده publishable وآمن يكون في التطبيق (الحماية عن طريق RLS)
window.RK_CONFIG = {
  SUPABASE_URL: 'https://gybdimrwofnvwpvtoikb.supabase.co',
  SUPABASE_KEY: 'sb_publishable_-4OlprLMmZXG1fIgKauyDQ_EV0lBS04',
  // نطاق الإيميل الوهمي لتسجيل الدخول برقم الموبايل
  EMAIL_DOMAIN: 'rickshawi.app',
  // مركز الخريطة الافتراضي (أم درمان)
  DEFAULT_CENTER: [15.6445, 32.4777],
  // خرائط مجانية بدون مفتاح: OpenStreetMap، ولو فشلت بنحوّل لـ Esri تلقائياً
  TILES: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  TILES_ATTR: '© OpenStreetMap',
  TILES_FALLBACK: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  TILES_FALLBACK_ATTR: '© Esri, OpenStreetMap',
  SEARCH_RADIUS_M: 3000,
  DRIVER_LOCATION_INTERVAL_MS: 8000,
  SUPPORT_PHONE: '[رقم الدعم]'
};
