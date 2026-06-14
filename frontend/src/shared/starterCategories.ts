import { Search, Hammer, PenLine, GraduationCap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Two-level starters shared by the empty-state and the first-run welcome chat: pick a
// category, then its concrete prompts. Every prompt is one-click-runnable (no [placeholders])
// and free-trial-safe, it touches the web or the App Builder sandbox, never the user's files.
// target 'app-builder' opens the App Builder (live preview); the rest run as a normal agent.
export type StarterCategory = {
  id: string;
  label: string;
  Icon: LucideIcon;
  prompts: string[];
  target?: 'app-builder';
};

export const STARTER_CATEGORIES: StarterCategory[] = [
  {
    id: 'research', label: 'Research', Icon: Search,
    prompts: [
      'Find today\'s top news and summarize it for me',
      'Compare the 3 best standing desks and recommend one',
      'Plan a weekend trip to Tokyo with a day-by-day itinerary',
      'Find the strangest world record I could actually break',
    ],
  },
  {
    id: 'build', label: 'Build', Icon: Hammer, target: 'app-builder',
    prompts: [
      'Build a focus timer that dings when the break starts',
      'Make a tip calculator that splits the bill',
      'Create a Snake game I can play right now',
      'Build a tiny Minecraft-style block world I can walk around in',
    ],
  },
  {
    id: 'write', label: 'Write', Icon: PenLine,
    prompts: [
      'Write a friendly email introducing myself to a new client',
      'Turn my rough notes into a polished update',
      'Write a product description for a coffee mug',
      'Write my morning routine as an epic fantasy quest',
    ],
  },
  {
    id: 'learn', label: 'Learn', Icon: GraduationCap,
    prompts: [
      'Explain how AI chatbots actually work, in plain English',
      'Teach me the basics of investing in 5 minutes',
      'Explain the stock market like I\'m five',
      'What would happen if the moon disappeared tomorrow?',
    ],
  },
];
