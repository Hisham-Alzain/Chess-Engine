import React from 'react';
import ReactDOM from 'react-dom/client';
import global_en from './translations/en/global.json';
import global_ar from './translations/ar/global.json';
import { I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import App from './App.jsx';
import './App.css';

const lng = localStorage.getItem('Lang');

if (lng !== null) {
  document.documentElement.lang = lng;
  if (lng === 'ar') {
    document.documentElement.dir = 'rtl';
  } else {
    document.documentElement.dir = 'ltr';
  }
} else {
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
}

i18next.init({
  // React already does escaping
  interpolation: { escapeValue: false },
  // Default Language
  lng: lng !== null ? lng : 'en',
  resources: {
    en: {
      global: global_en
    },
    ar: {
      global: global_ar
    }
  }
});


ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18next}>
      <App />
    </I18nextProvider>
  </React.StrictMode>
);
