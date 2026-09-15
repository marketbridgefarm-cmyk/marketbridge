const translations = {
  en: { farmProduce: 'Farm Produce', products: 'Products', digital: 'Digital', language: 'Language', region: 'Region', zone: 'Zone', woreda: 'Woreda', kebele: 'Kebele', verified: 'Verified', inspected: 'Inspected', search: 'Search', listProduce: 'List produce' },
  am: { farmProduce: 'የእርሻ ምርቶች', products: 'ምርቶች', digital: 'ዲጂታል', language: 'ቋንቋ', region: 'ክልል', zone: 'ዞን', woreda: 'ወረዳ', kebele: 'ቀበሌ', verified: 'የተረጋገጠ', inspected: 'የተመረመረ', search: 'ፈልግ', listProduce: 'ምርት ይመዝግቡ' },
  om: { farmProduce: 'Oomisha Qonnaa', products: 'Oomishaalee', digital: 'Dijitaalaa', language: 'Afaan', region: 'Naannoo', zone: 'Godina', woreda: 'Aanaa', kebele: 'Ganda', verified: 'Mirkanaa’e', inspected: 'Qoratame', search: 'Barbaadi', listProduce: 'Oomisha galchi' },
};
export function getLanguage() { return localStorage.getItem('mb_language') || 'en'; }
export function setLanguage(lang) { if (translations[lang]) localStorage.setItem('mb_language', lang); }
export function t(key, lang = getLanguage()) { return translations[lang]?.[key] || translations.en[key] || key; }
export const supportedLanguages = [['en','English'],['am','አማርኛ'],['om','Afaan Oromoo']];
