export function resolveAppLocale(value: string | undefined): string {
  return value?.trim() || 'en';
}
