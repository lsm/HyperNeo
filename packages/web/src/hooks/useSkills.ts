import { useState, useEffect } from 'preact/hooks';
import type { AppSkill } from '@hyperneo/shared';
import { skillsStore } from '../lib/skills-store';

interface UseSkillsResult {
  skills: AppSkill[];
  isLoading: boolean;
  error: string | null;
}

export function useSkills(): UseSkillsResult {
  const [skills, setSkills] = useState<AppSkill[]>(skillsStore.skills.value);
  const [isLoading, setIsLoading] = useState<boolean>(skillsStore.isLoading.value);
  const [error, setError] = useState<string | null>(skillsStore.error.value);

  useEffect(() => {
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
