export const NICHES = [
  'Tech/AI',
  'Finance',
  'Motivation',
  'History',
  'Top 10',
  'Scary Stories',
  'Health & Fitness',
  'Education',
  'Entertainment',
  'Other',
] as const;

export type Niche = (typeof NICHES)[number];
