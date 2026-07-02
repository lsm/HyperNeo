/**
 * useSkills Hook
 *
 * Lifecycle adapter that manages the global Skills registry LiveQuery subscription.
 *
 * Responsibilities:
 * - On mount: subscribe to skillsStore signals via callback, then start the LiveQuery
 * - On unmount: unsubscribe from signals and tear down the LiveQuery
 *
 * Signal bridging: uses signal.subscribe() to push plain values into useState so that
 * SkillsRegistry never reads signal.value directly in its component body or JSX. This
 * avoids the @preact/preset-vite transform from creating conflicting fine-grained
 * subscriptions that produce double-rendered VNode trees.
 */

import { useState, useEffect } from 'preact/hooks';
import type { AppSkill } from '@hyperneo/shared';
import { skillsStore } from '../lib/skills-store';

interface UseSkillsResult {
  skills: AppSkill[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Subscribe to the global Skills registry and return plain reactive values.
 *
 * Uses signal.subscribe() callbacks to bridge signals into useState, so that
 * the consuming component only sees plain JS values (not Signal objects).
 * This prevents the @preact/preset-vite signals transform from creating
 * extra component-level subscriptions that cause double-render artifacts.
 *
 * Manages the LiveQuery subscription lifecycle:
 * subscribe on mount, unsubscribe on unmount.
 */
export function useSkills(): UseSkillsResult {
  const [skills, setSkills] = useState<AppSkill[]>(skillsStore.skills.value);
  const [isLoading, setIsLoading] = useState<boolean>(skillsStore.isLoading.value);
  const [error, setError] = useState<string | null>(skillsStore.error.value);

  useEffect(() => {
    // Bridge signal changes into useState. signal.subscribe() calls the
    // callback immediately with the current value, then on every future change.
    const unsubSkills = skillsStore.skills.subscribe(setSkills);
    const unsubLoading = skillsStore.isLoading.subscribe(setIsLoading);
    const unsubError = skillsStore.error.subscribe(setError);

    skillsStore.subscribe().catch(() => {
      // Error is surfaced via skillsStore.error signal → setError callback above
    });

    return () => {
      unsubSkills();
      unsubLoading();
      unsubError();
      skillsStore.unsubscribe();
    };
  }, []);

  return { skills, isLoading, error };
}
