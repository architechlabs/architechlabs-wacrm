import { getRequestConfig } from 'next-intl/server';

import { resolveAppLocale } from './locale';

export default getRequestConfig(async () => {
  // Read the locale from the environment, defaulting to 'en'
  const locale = resolveAppLocale(process.env.NEXT_PUBLIC_APP_LOCALE);

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages,
  };
});
