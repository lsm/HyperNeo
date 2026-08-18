import { useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useSignal, useSignalEffect } from '@preact/signals';
import { appendDraftText, generateUUID } from '@hyperneo/shared';
import { connectionManager } from '../lib/connection-manager';
import { connectionState } from '../lib/state';
import {
  clearDraftBackup,
  consumeVoiceTranscriptLanded,
  getClearTombstone,
  getDraftBackup,
  getLandingGeneration,
  getLandingTranscript,
  hasClearTombstone,
  isLandingLive,
  peekExpiredDraftBackup,
  removeClearTombstone,
  retireDraftBackupClaim,
  saveClearTombstone,
  saveDraftBackup,
  voiceTranscriptLandedSignal,
} from '../lib/voice/voice-transcript-outbox';

function transcriptsFromMerge(
  draft: string | undefined,
  baseline: string | null | undefined
): string | null {
  if (typeof baseline !== 'string' || draft === undefined) return null;
  if (draft === baseline) return '';
  if (draft.startsWith(`${baseline} `)) return draft.slice(baseline.length + 1);
  if (draft.startsWith(baseline)) return draft.slice(baseline.length);
  return null;
}

export interface UseInputDraftResult {
  content: string;
  setContent: (content: string) => void;
  clear: () => void;
}

export function useInputDraft(sessionId: string, debounceMs = 250): UseInputDraftResult {
  const contentSignal = useSignal('');
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  const currentSessionIdRef = useRef(sessionId);
  const initialLoadSettledRef = useRef<string | null>(null);
  const foldedLandingRef = useRef<Map<string, number>>(new Map());
  const pendingClearRef = useRef<string | null>(null);
  const draftVersionsRef = useRef<Map<string, number>>(new Map());
  const flushKickRef = useRef<() => void>(() => {});
  const activeMergeClaimsRef = useRef<Map<string, { claimId: string; content: string }>>(new Map());

  const advanceDraftVersion = (sid: string, version: number | undefined): void => {
    if (typeof version !== 'number') return;
    const cached = draftVersionsRef.current.get(sid);
    if (cached === undefined || version > cached) draftVersionsRef.current.set(sid, version);
  };
  const consumeLanding = useCallback((sessionId: string, generation: number): void => {
    foldedLandingRef.current.set(sessionId, generation);
    removeClearTombstone(sessionId);
    consumeVoiceTranscriptLanded(sessionId, generation);
  }, []);

  const loadDraft = useCallback(
    (
      targetSessionId: string,
      isCancelled: () => boolean,
      onResult?: (
        ok: boolean,
        pendingRetained?: boolean,
        wasCancelled?: boolean,
        draft?: string,
        baseline?: string | null,
        baselineSeq?: number | null
      ) => void,
      reconcileOnCancel?: boolean
    ): void => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        onResult?.(false);
        return;
      }
      const requestedGeneration = voiceTranscriptLandedSignal.peek().get(targetSessionId);
      hub
        .request<{
          session: {
            metadata?: {
              inputDraft?: string;
              inputDraftVoicePending?: string | null;
              inputDraftVoiceBaseline?: string | null;
              inputDraftVoiceBaselineSeq?: number | null;
              inputDraftVersion?: number | null;
            };
          };
        }>('session.get', {
          sessionId: targetSessionId,
        })
        .then((response) => {
          const cancelled = isCancelled();
          const draft = response.session?.metadata?.inputDraft;
          const baseline = response.session?.metadata?.inputDraftVoiceBaseline;
          const baselineSeq = response.session?.metadata?.inputDraftVoiceBaselineSeq;
          const pendingRetained = !!response.session?.metadata?.inputDraftVoicePending;
          if (typeof response.session?.metadata?.inputDraftVersion === 'number') {
            advanceDraftVersion(targetSessionId, response.session.metadata.inputDraftVersion);
          }
          if (!cancelled && draft) {
            contentSignal.value = draft;
          } else if (
            cancelled &&
            reconcileOnCancel &&
            !pendingRetained &&
            currentSessionIdRef.current === targetSessionId &&
            foldedLandingRef.current.get(targetSessionId) !== requestedGeneration
          ) {
            const transcript =
              transcriptsFromMerge(draft, baseline) ?? getLandingTranscript(targetSessionId);
            if (transcript) {
              contentSignal.value = appendDraftText(contentSignal.peek(), transcript);
            }
            if (requestedGeneration !== undefined) {
              foldedLandingRef.current.set(targetSessionId, requestedGeneration);
            }
          }
          onResult?.(true, pendingRetained, cancelled, draft, baseline, baselineSeq);
        })
        .catch(() => {
          if (isCancelled()) return;
          onResult?.(false);
        });
    },
    [contentSignal]
  );

  const reconcileOwedClear = useCallback(
    (targetSessionId: string): void => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;
      const tombstone = getClearTombstone(targetSessionId);
      hub
        .request<{
          session?: {
            metadata?: {
              inputDraft?: string;
              inputDraftVoicePending?: string | null;
              inputDraftVoiceBaseline?: string | null;
              inputDraftVoiceBaselineSeq?: number | null;
              inputDraftVoiceLastStrippedSeq?: number | null;
            };
          };
        }>('session.get', { sessionId: targetSessionId })
        .then((response) => {
          const meta = response.session?.metadata ?? {};
          const observedDraft = meta.inputDraft ?? '';
          const canAdopt = (): boolean =>
            currentSessionIdRef.current === targetSessionId &&
            (contentSignal.peek().trim() === '' || contentSignal.peek() === observedDraft);
          if (
            tombstone?.baselineSeq !== undefined &&
            meta.inputDraftVoiceLastStrippedSeq === tombstone.baselineSeq
          ) {
            if (canAdopt()) {
              contentSignal.value = meta.inputDraft ?? '';
            }
            removeClearTombstone(targetSessionId);
            if (pendingClearRef.current === targetSessionId) {
              pendingClearRef.current = null;
            }
            return;
          }
          if ((meta.inputDraftVoicePending ?? '').trim() !== '') {
            return hub
              .request<{ cleared?: boolean }>('session.clearInputDraftIf', {
                sessionId: targetSessionId,
                expected: meta.inputDraft ?? '',
              })
              .then((result) => {
                if (!result.cleared) {
                  flushKickRef.current();
                  return;
                }
                return hub
                  .request<{ session?: { metadata?: { inputDraft?: string } } }>('session.get', {
                    sessionId: targetSessionId,
                  })
                  .then((merged) => {
                    if (currentSessionIdRef.current === targetSessionId) {
                      const mergedDraft = merged.session?.metadata?.inputDraft ?? '';
                      if (
                        contentSignal.peek().trim() === '' ||
                        contentSignal.peek() === observedDraft
                      ) {
                        contentSignal.value = mergedDraft;
                      }
                    }
                    removeClearTombstone(targetSessionId);
                    if (pendingClearRef.current === targetSessionId) {
                      pendingClearRef.current = null;
                    }
                  });
              })
              .catch(() => {
                /* stays owed — the reconnect subscription retries */
              });
          }
          if (
            typeof meta.inputDraftVoiceBaseline === 'string' &&
            typeof meta.inputDraftVoiceBaselineSeq === 'number'
          ) {
            saveClearTombstone(targetSessionId, meta.inputDraftVoiceBaselineSeq);
            return hub
              .request<{ updated?: boolean; value?: string }>('session.stripVoiceBaseline', {
                sessionId: targetSessionId,
                expected: meta.inputDraft ?? '',
                expectedSeq: meta.inputDraftVoiceBaselineSeq,
              })
              .then((result) => {
                if (!result.updated) {
                  flushKickRef.current();
                  return;
                }
                if (canAdopt()) {
                  contentSignal.value = result.value ?? '';
                }
                removeClearTombstone(targetSessionId);
                if (pendingClearRef.current === targetSessionId) {
                  pendingClearRef.current = null;
                }
              });
          }
          return hub
            .request<{ cleared?: boolean }>('session.clearInputDraftIf', {
              sessionId: targetSessionId,
              expected: meta.inputDraft ?? '',
            })
            .then((result) => {
              if (!result.cleared) {
                flushKickRef.current();
                return;
              }
              if (canAdopt()) {
                contentSignal.value = '';
              }
              removeClearTombstone(targetSessionId);
              if (pendingClearRef.current === targetSessionId) {
                pendingClearRef.current = null;
              }
            });
        })
        .catch(() => {
          /* stays owed — the reconnect subscription retries */
        });
    },
    [contentSignal]
  );

  useEffect(() => {
    if (!sessionId) {
      contentSignal.value = '';
      return;
    }

    initialLoadSettledRef.current = null;
    currentSessionIdRef.current = sessionId;

    contentSignal.value = '';

    let cancelled = false;
    loadDraft(
      sessionId,
      () => cancelled,
      (ok, pendingRetained, wasCancelled, draft, baseline) => {
        if (wasCancelled) return;
        initialLoadSettledRef.current = sessionId;
        if (hasClearTombstone(sessionId)) {
          pendingClearRef.current = sessionId;
          if (isLandingLive(sessionId)) {
            voiceTranscriptLandedSignal.value = new Map(voiceTranscriptLandedSignal.value);
          } else {
            void reconcileOwedClear(sessionId);
          }
          return;
        }
        const claimed = peekExpiredDraftBackup(sessionId);
        const backup = getDraftBackup(sessionId) ?? claimed?.content ?? null;
        const generation = voiceTranscriptLandedSignal.value.get(sessionId);
        const landingLive = generation !== undefined && isLandingLive(sessionId);
        if (!ok) {
          if (backup !== null && landingLive) contentSignal.value = backup;
          return;
        }
        if (pendingRetained) {
          if (backup !== null) {
            contentSignal.value = backup;
            if (!landingLive && claimed) {
              pendingBackupFlushRef.current.set(sessionId, {
                content: claimed.content.trim(),
                generation: claimed.generation,
                key: claimed.key,
                claimId: generateUUID(),
                ts: claimed.ts,
              });
              flushKickRef.current();
            }
          }
          return;
        }
        let transcripts = transcriptsFromMerge(draft, baseline);
        const aggregate = landingLive ? getLandingTranscript(sessionId) : null;
        if (
          aggregate &&
          draft?.endsWith(aggregate) &&
          aggregate.length > (transcripts?.length ?? -1)
        ) {
          transcripts = aggregate;
        }
        if (backup === null) {
          if (landingLive) consumeLanding(sessionId, generation);
          return;
        }
        if (transcripts === null) {
          if (landingLive) contentSignal.value = backup;
          return;
        }
        contentSignal.value = appendDraftText(backup, transcripts);
        if (landingLive) consumeLanding(sessionId, generation);
        else if (claimed) retireDraftBackupClaim(claimed);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, contentSignal, loadDraft, consumeLanding, reconcileOwedClear]);

  const prevReplayContentRef = useRef<{ sessionId: string | null; content: string }>({
    sessionId: null,
    content: '',
  });
  useSignalEffect(() => {
    const generation = voiceTranscriptLandedSignal.value.get(sessionId);
    if (generation === undefined || !isLandingLive(sessionId)) return;
    if (initialLoadSettledRef.current !== sessionId) return;
    void connectionState.value;
    const content = contentSignal.value;
    const justCleared =
      prevReplayContentRef.current.sessionId === sessionId &&
      prevReplayContentRef.current.content.trim() !== '';
    prevReplayContentRef.current = { sessionId, content };
    if (content.trim() !== '' && pendingClearRef.current !== sessionId) return;
    let cancelled = false;
    const oweClear = (baselineSeq?: number) => {
      pendingClearRef.current = sessionId;
      const persisted = saveClearTombstone(sessionId, baselineSeq);
      if (!persisted) {
        clearDraftBackup(sessionId);
      }
    };
    const stillCurrent = () => currentSessionIdRef.current === sessionId;
    const refresh = () => {
      if (!stillCurrent()) return;
      loadDraft(
        sessionId,
        () => cancelled,
        (ok, pendingRetained, _wasCancelled) => {
          if (ok && !pendingRetained) consumeLanding(sessionId, generation);
        },
        true
      );
    };
    if (justCleared || pendingClearRef.current === sessionId) {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        oweClear();
        return () => {
          cancelled = true;
        };
      }
      pendingClearRef.current = null;
      if (!saveClearTombstone(sessionId)) clearDraftBackup(sessionId);
      loadDraft(
        sessionId,
        () => cancelled,
        (ok, pendingRetained, _wasCancelled, draft, _baseline, baselineSeq) => {
          if (!ok) {
            oweClear();
            return;
          }
          if (pendingRetained) {
            hub
              .request<{ cleared?: boolean }>('session.clearInputDraftIf', {
                sessionId,
                expected: draft ?? '',
              })
              .then((result) => {
                if (!result.cleared) {
                  oweClear();
                  return;
                }
                if (stillCurrent()) refresh();
              })
              .catch(() => {
                oweClear();
              });
            return;
          }
          if (typeof baselineSeq === 'number') saveClearTombstone(sessionId, baselineSeq);
          hub
            .request<{ updated?: boolean; value?: string }>('session.stripVoiceBaseline', {
              sessionId,
              expected: draft ?? '',
              expectedSeq: baselineSeq ?? undefined,
            })
            .then((result) => {
              if (!stillCurrent()) return;
              if (result.updated) {
                const currentContent = contentSignal.peek();
                const stripped = result.value ?? '';
                if (currentContent.trim() === '' || currentContent === (draft ?? '')) {
                  contentSignal.value = stripped;
                } else if (stripped.trim() !== '') {
                  contentSignal.value = appendDraftText(currentContent, stripped);
                }
                consumeLanding(sessionId, generation);
              } else {
                refresh();
              }
            })
            .catch(() => {
              oweClear(baselineSeq ?? undefined);
            });
        },
        true
      );
      return () => {
        cancelled = true;
      };
    }
    refresh();
    return () => {
      cancelled = true;
    };
  });

  const lastSeenContentRef = useRef<{
    sessionId: string | null;
    content: string;
    cleared?: boolean;
  }>({ sessionId: null, content: '' });
  const pendingBackupFlushRef = useRef<
    Map<
      string,
      {
        content: string;
        generation: number;
        key: string;
        claimId: string;
        ts: number;
      }
    >
  >(new Map());
  useEffect(() => {
    const flushRetryTimerRef: { current: ReturnType<typeof setTimeout> | null } = {
      current: null,
    };
    let flushRetryDelayMs = 5_000;
    const scheduleFlushRetry = () => {
      if (flushRetryTimerRef.current) return;
      flushRetryTimerRef.current = setTimeout(() => {
        flushRetryTimerRef.current = null;
        retryBackupFlush();
      }, flushRetryDelayMs);
      flushRetryDelayMs = Math.min(flushRetryDelayMs * 2, 60_000);
    };
    const retryBackupFlush = () => {
      if (connectionState.value !== 'connected') return;
      if (
        !isLandingLive(currentSessionIdRef.current) &&
        hasClearTombstone(currentSessionIdRef.current)
      ) {
        reconcileOwedClear(currentSessionIdRef.current);
      }
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;
      const queued = [...pendingBackupFlushRef.current.entries()];
      pendingBackupFlushRef.current.clear();
      const requeueClaim = (
        flushSessionId: string,
        entry: { content: string; generation: number; key: string; claimId: string; ts: number }
      ) => {
        const newer = pendingBackupFlushRef.current.get(flushSessionId);
        if (
          newer &&
          (newer.generation > entry.generation ||
            (newer.generation === entry.generation && newer.ts > entry.ts))
        ) {
          return;
        }
        pendingBackupFlushRef.current.set(flushSessionId, entry);
        scheduleFlushRetry();
      };
      for (const [flushSessionId, { content, generation, key, claimId, ts }] of queued) {
        if (flushSessionId === currentSessionIdRef.current) {
          if (contentSignal.peek().trim() === '') {
            hub
              .request<{ merged?: boolean; value?: string }>('session.mergeVoiceDraftBackup', {
                sessionId: flushSessionId,
                content,
                claimId,
              })
              .then((result) => {
                if (!result.merged) {
                  requeueClaim(flushSessionId, { content, generation, key, claimId, ts });
                  return;
                }
                if (currentSessionIdRef.current === flushSessionId) {
                  if (contentSignal.peek().trim() === '') {
                    contentSignal.value = result.value ?? content;
                  }
                }
                retireDraftBackupClaim({ key, generation, ts });
              })
              .catch(() => {
                requeueClaim(flushSessionId, { content, generation, key, claimId, ts });
              });
          } else {
            const active = contentSignal.peek().trim();
            const boundClaim = activeMergeClaimsRef.current.get(flushSessionId);
            const activeClaimId =
              boundClaim && boundClaim.content === active ? boundClaim.claimId : generateUUID();
            activeMergeClaimsRef.current.set(flushSessionId, {
              claimId: activeClaimId,
              content: active,
            });
            hub
              .request<{ merged?: boolean; value?: string }>('session.mergeVoiceDraftBackup', {
                sessionId: flushSessionId,
                content: active,
                claimId: activeClaimId,
              })
              .then((result) => {
                if (result.merged) {
                  activeMergeClaimsRef.current.delete(flushSessionId);
                  retireDraftBackupClaim({ key, generation, ts });
                  if (
                    flushSessionId === currentSessionIdRef.current &&
                    contentSignal.peek().trim() === active
                  ) {
                    contentSignal.value = result.value ?? active;
                  }
                  return;
                }
                requeueClaim(flushSessionId, {
                  content: active,
                  generation,
                  key,
                  claimId: activeClaimId,
                  ts,
                });
              })
              .catch(() => {
                requeueClaim(flushSessionId, {
                  content: active,
                  generation,
                  key,
                  claimId: activeClaimId,
                  ts,
                });
              });
          }
          continue;
        }
        hub
          .request<{ merged?: boolean }>('session.mergeVoiceDraftBackup', {
            sessionId: flushSessionId,
            content,
            claimId,
          })
          .then((result) => {
            if (result.merged) {
              retireDraftBackupClaim({ key, generation, ts });
              return;
            }
            requeueClaim(flushSessionId, { content, generation, key, claimId, ts });
          })
          .catch(() => {
            requeueClaim(flushSessionId, { content, generation, key, claimId, ts });
          });
      }
    };
    flushKickRef.current = () => {
      if (connectionState.value === 'connected') scheduleFlushRetry();
    };
    const unsubscribe = connectionState.subscribe(retryBackupFlush);
    return () => {
      unsubscribe();
      flushKickRef.current = () => {};
      if (flushRetryTimerRef.current) clearTimeout(flushRetryTimerRef.current);
    };
  }, [contentSignal, reconcileOwedClear]);
  useSignalEffect(() => {
    const content = contentSignal.value;

    if (!sessionId) return;
    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current);
      draftSaveTimeoutRef.current = null;
    }
    if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
      const prevSessionId = prevSessionIdRef.current;
      const last = lastSeenContentRef.current;
      const trimmedContent = last.sessionId === prevSessionId ? last.content.trim() : '';
      const prevHasLanding = isLandingLive(prevSessionId);
      if (prevHasLanding) {
        const liveClaim = peekExpiredDraftBackup(prevSessionId);
        if (liveClaim?.content.trim()) {
          pendingBackupFlushRef.current.set(prevSessionId, {
            content: liveClaim.content.trim(),
            generation: liveClaim.generation,
            key: liveClaim.key,
            claimId: generateUUID(),
            ts: liveClaim.ts,
          });
          flushKickRef.current();
        }
        prevSessionIdRef.current = sessionId;
        return;
      }
      const claimed = peekExpiredDraftBackup(prevSessionId);
      const flushClaimId = claimed ? generateUUID() : null;
      const flushContent = claimed?.content.trim() || trimmedContent;
      const queueRetry = () => {
        if (claimed?.content.trim()) {
          pendingBackupFlushRef.current.set(prevSessionId, {
            content: claimed.content.trim(),
            generation: claimed.generation,
            key: claimed.key,
            claimId: flushClaimId ?? generateUUID(),
            ts: claimed.ts,
          });
          flushKickRef.current();
        }
      };
      const pushBackup = () => {
        const hub = connectionManager.getHubIfConnected();
        if (!hub) {
          queueRetry();
          return;
        }
        if (!flushContent && !(last.sessionId === prevSessionId && last.cleared)) return;
        if (!claimed) {
          hub
            .request<{ draftVersion?: number; draftValue?: string }>('session.update', {
              sessionId: prevSessionId,
              expectedDraftVersion: draftVersionsRef.current.get(prevSessionId),
              metadata: {
                inputDraft: flushContent || null,
              },
            })
            .then((ack) => {
              if (typeof ack?.draftValue !== 'string') {
                advanceDraftVersion(prevSessionId, ack?.draftVersion);
              }
            })
            .catch(() => {
              /* ignore flush errors */
            });
          return;
        }
        hub
          .request<{ merged?: boolean }>('session.mergeVoiceDraftBackup', {
            sessionId: prevSessionId,
            content: flushContent,
            claimId: flushClaimId ?? undefined,
          })
          .then((result) => {
            if (result.merged) retireDraftBackupClaim(claimed);
            else queueRetry();
          })
          .catch(() => {
            queueRetry();
          });
      };
      pushBackup();
      prevSessionIdRef.current = sessionId;
      return;
    }
    prevSessionIdRef.current = sessionId;

    if (isLandingLive(sessionId)) {
      if (content.trim() !== '') {
        const backedUp = saveDraftBackup(sessionId, content, getLandingGeneration(sessionId) ?? 0);
        if (backedUp) return;
      } else {
        return;
      }
    }

    const trimmedContent = content.trim();

    if (trimmedContent === '') {
      if (initialLoadSettledRef.current !== sessionId) return;
      lastSeenContentRef.current = { sessionId, content: '', cleared: true };
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        hub
          .request<{ draftVersion?: number; draftValue?: string }>('session.update', {
            sessionId,
            expectedDraftVersion: draftVersionsRef.current.get(sessionId),
            metadata: {
              inputDraft: null,
            },
          })
          .then((ack) => {
            if (typeof ack?.draftValue !== 'string') {
              advanceDraftVersion(sessionId, ack?.draftVersion);
            }
            if (lastSeenContentRef.current.sessionId === sessionId) {
              lastSeenContentRef.current = { sessionId, content: '' };
            }
          })
          .catch(() => {
            /* ignore clear errors */
          });
      }
      return;
    }

    lastSeenContentRef.current = { sessionId, content };
    draftSaveTimeoutRef.current = setTimeout(async () => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;

      try {
        const ack = await hub.request<{ draftVersion?: number; draftValue?: string }>(
          'session.update',
          {
            sessionId,
            expectedDraftVersion: draftVersionsRef.current.get(sessionId),
            metadata: {
              inputDraft: trimmedContent,
            },
          }
        );
        if (typeof ack?.draftValue === 'string') {
          if (
            currentSessionIdRef.current === sessionId &&
            contentSignal.peek().trim() === trimmedContent
          ) {
            contentSignal.value = ack.draftValue;
            advanceDraftVersion(sessionId, ack.draftVersion);
          }
          return;
        }
        advanceDraftVersion(sessionId, ack?.draftVersion);
      } catch {
        // Ignore draft save errors
      }
    }, debounceMs);

    return () => {
      if (draftSaveTimeoutRef.current) {
        clearTimeout(draftSaveTimeoutRef.current);
        draftSaveTimeoutRef.current = null;
      }
    };
  });

  const setContent = useCallback(
    (newContent: string) => {
      contentSignal.value = newContent;
    },
    [contentSignal]
  );

  const clear = useCallback(() => {
    contentSignal.value = '';
  }, [contentSignal]);

  return useMemo(
    () => ({
      get content() {
        return contentSignal.value;
      },
      setContent,
      clear,
    }),
    [contentSignal, setContent, clear]
  );
}
