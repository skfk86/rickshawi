// إعدادات ركشتي — المفتاح ده publishable وآمن يكون في التطبيق (الحماية عن طريق RLS)
window.RK_CONFIG = {
  SUPABASE_URL: 'https://gybdimrwofnvwpvtoikb.supabase.co',
  SUPABASE_KEY: 'sb_publishable_-4OlprLMmZXG1fIgKauyDQ_EV0lBS04',
  // نطاق الإيميل الوهمي لتسجيل الدخول برقم الموبايل
  EMAIL_DOMAIN: 'rickshawi.app',
  // مركز الخريطة الافتراضي (أم درمان)
  DEFAULT_CENTER: [15.6445, 32.4777],
  TILES: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  TILES_ATTR: '© OpenStreetMap © CARTO',
  SEARCH_RADIUS_M: 3000,
  DRIVER_LOCATION_INTERVAL_MS: 8000,
  SUPPORT_PHONE: '[رقم الدعم]'
};
