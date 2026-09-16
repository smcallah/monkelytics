export function parseSaltRotation(value: string | undefined): 'day' | 'week' | 'month' {
  if (value === undefined) return 'month';
  if (value === 'day' || value === 'week' || value === 'month') return value;

  throw new Error('SALT_ROTATION must be one of: day, week, month.');
}
