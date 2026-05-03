window.OCR_APP_CONFIG = {
  // Set this to your OCR API base URL in production.
  // Keep empty for same-origin local development.
  apiBaseUrl: '',

  // Optional: set a dedicated API host for desktop hardware scanner route.
  // Example local Windows API: http://localhost:3099
  hardwareScannerApiBaseUrl: '',

  // Token source for integration with main Ibnu Hafidz web.
  // You can pass token in URL query (?token=...) or store token in one of these keys.
  authTokenQueryParam: 'token',
  authTokenStorageKeys: ['ibnu_hafidz_access_token', 'access_token', 'token'],
};
