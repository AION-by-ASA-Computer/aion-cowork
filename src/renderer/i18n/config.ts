import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enTranslations from './locales/en.json';
import itTranslations from './locales/it.json';

i18n
  .use(LanguageDetector) // Detect the browser language automatically
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: enTranslations,
      },
      it: {
        translation: itTranslations,
      },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'it'],
    nonExplicitSupportedLngs: true, // map it-IT -> it, en-US -> en
    interpolation: {
      escapeValue: false, // React already escapes values
    },
    pluralSeparator: '_',
    contextSeparator: '_',
    detection: {
      order: ['localStorage', 'navigator'], // saved choice first, then browser language
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
    },
  });

export default i18n;
