| run | all | synthetic | real | follow-ups → inbox | p50 ms | p95 ms | acc. with 4 s timeout | cost / 1k | errors |
|---|---|---|---|---|---|---|---|---|---|
| tts-kev-4b-q4km-llamacpp-cpu | 75% | 67% | 91% | 9/74 | 15160 | 32595 | 56% | $0 (local) | 0 |
| ai0-laya-multilingual-torch-cuda | 14% | 21% | 0% | 0/74 | 48 | 123 | 14% | $0 (local) | 0 |
| ai0-kev-4b-q4km-llamacpp-cuda | 75% | 67% | 91% | 9/74 | 525 | 989 | 75% | $0 (local) | 0 |
| tts-llm-glm-native-message-only | 67% | 73% | 54% | 18/74 | 3487 | 5621 | 62% | $0.37 | 0 |
| macbook-kev-4b-mlx | 79% | 71% | 94% | 7/74 | 358 | 723 | 79% | $0 (local) | 0 |
| tts-llm-glm-lean-thinkingon-rerun-message-only | 71% | 79% | 57% | 10/74 | 2034 | 4412 | 76% | $0.54 | 0 |
| tts-llm-glm-flash-lean-context | 92% | 94% | 89% | 0/74 | 1971 | 3703 | 93% | $0.15 | 0 |
| macbook-kev-0.8b-mlx | 64% | 63% | 66% | 5/74 | 84 | 167 | 64% | $0 (local) | 0 |
| tts-kev-0.8b-q8-llamacpp-cpu | 63% | 61% | 66% | 6/74 | 5500 | 11183 | 56% | $0 (local) | 0 |
| tts-llm-deepseek-lean-message-only | 66% | 74% | 49% | 15/74 | 1240 | 1488 | 66% | $0.10 | 0 |
| tts-llm-glm-lean-context | 94% | 96% | 91% | 0/74 | 2255 | 3775 | 93% | $0.93 | 0 |
| macbook-llm-haiku-deployed-message-only | 50% | 60% | 31% | 31/74 | 1716 | 2890 | 50% | $3.59 | 0 |
| tts-llm-glm-flash-native-message-only | 68% | 76% | 51% | 11/74 | 1033 | 2840 | 68% | $0.06 | 0 |
| tts-llm-glm-flash-lean-message-only | 77% | 87% | 57% | 5/74 | 2187 | 5891 | 82% | $0.09 | 0 |
| tts-llm-glm-deployed-context | 89% | 90% | 86% | 0/74 | 1942 | 3719 | 88% | $0.90 | 0 |
| macbook-llm-haiku-deployed-context | 90% | 90% | 91% | 0/74 | 1538 | 2832 | 90% | $4.24 | 0 |
| tts-llm-glm-flash-native-context | 90% | 91% | 89% | 0/74 | 1002 | 2266 | 90% | $0.13 | 0 |
| tts-llm-glm-native-context | 87% | 89% | 83% | 0/74 | 3780 | 5342 | 74% | $0.77 | 0 |
| ai0-kev-0.8b-q8-llamacpp-cuda | 63% | 61% | 66% | 6/74 | 209 | 406 | 63% | $0 (local) | 0 |
| macbook-llm-haiku-lean-context | 80% | 79% | 83% | 0/74 | 1536 | 2622 | 79% | $1.60 | 0 |
| tts-llm-deepseek-lean-context | 86% | 87% | 83% | 0/74 | 1232 | 1506 | 86% | $0.18 | 0 |
| ai0-gliner2.5-decide-torch-cuda | 21% | 20% | 23% | 0/74 | 193 | 886 | 21% | $0 (local) | 8 |
| tts-llm-luna-lean-context | 88% | 91% | 80% | 2/74 | 1911 | 4707 | 89% | $0.25 | 0 |
| macbook-llm-haiku-lean-message-only | 49% | 57% | 31% | 30/74 | 1412 | 2091 | 49% | $0.95 | 0 |
| tts-llm-luna-lean-message-only | 63% | 69% | 51% | 21/74 | 2364 | 7738 | 60% | $0.14 | 0 |
| tts-llm-glm-deployed-message-only | 74% | 80% | 63% | 5/74 | 2214 | 5159 | 75% | $0.56 | 0 |

| run | follow_up | second_last | waiting_yes | two_waiting | one_off | new_subject | thanks | long_dictated | mixed_language | real |
|---|---|---|---|---|---|---|---|---|---|---|
| tts-kev-4b-q4km-llamacpp-cpu | 75% | 100% | 100% | 33% | 100% | 0% | 0% | 83% | 88% | 91% |
| ai0-laya-multilingual-torch-cuda | 42% | 38% | 38% | 17% | 0% | 0% | 17% | 17% | 13% | 0% |
| ai0-kev-4b-q4km-llamacpp-cuda | 75% | 100% | 100% | 33% | 100% | 0% | 0% | 83% | 88% | 91% |
| tts-llm-glm-native-message-only | 67% | 100% | 63% | 33% | 100% | 88% | 0% | 100% | 88% | 54% |
| macbook-kev-4b-mlx | 92% | 100% | 100% | 33% | 100% | 13% | 0% | 83% | 88% | 94% |
| tts-llm-glm-lean-thinkingon-rerun-message-only | 83% | 100% | 38% | 83% | 100% | 88% | 33% | 83% | 88% | 57% |
| tts-llm-glm-flash-lean-context | 100% | 100% | 100% | 100% | 63% | 100% | 100% | 100% | 88% | 89% |
| macbook-kev-0.8b-mlx | 58% | 63% | 75% | 50% | 25% | 88% | 67% | 100% | 50% | 66% |
| tts-kev-0.8b-q8-llamacpp-cpu | 58% | 63% | 75% | 50% | 25% | 88% | 67% | 83% | 50% | 66% |
| tts-llm-deepseek-lean-message-only | 67% | 88% | 63% | 67% | 100% | 88% | 0% | 100% | 88% | 49% |
| tts-llm-glm-lean-context | 100% | 100% | 100% | 100% | 88% | 100% | 100% | 100% | 75% | 91% |
| macbook-llm-haiku-deployed-message-only | 58% | 100% | 38% | 33% | 100% | 38% | 0% | 83% | 75% | 31% |
| tts-llm-glm-flash-native-message-only | 83% | 100% | 38% | 67% | 100% | 88% | 17% | 83% | 88% | 51% |
| tts-llm-glm-flash-lean-message-only | 92% | 100% | 38% | 100% | 100% | 88% | 83% | 100% | 88% | 57% |
| tts-llm-glm-deployed-context | 100% | 100% | 100% | 83% | 38% | 100% | 100% | 100% | 88% | 86% |
| macbook-llm-haiku-deployed-context | 100% | 100% | 100% | 50% | 63% | 88% | 100% | 100% | 100% | 91% |
| tts-llm-glm-flash-native-context | 100% | 100% | 100% | 100% | 50% | 88% | 100% | 100% | 88% | 89% |
| tts-llm-glm-native-context | 100% | 100% | 100% | 33% | 63% | 100% | 100% | 100% | 88% | 83% |
| ai0-kev-0.8b-q8-llamacpp-cuda | 58% | 63% | 75% | 50% | 25% | 88% | 67% | 83% | 50% | 66% |
| macbook-llm-haiku-lean-context | 100% | 100% | 100% | 33% | 25% | 100% | 67% | 100% | 63% | 83% |
| tts-llm-deepseek-lean-context | 100% | 100% | 100% | 33% | 63% | 88% | 100% | 100% | 88% | 83% |
| ai0-gliner2.5-decide-torch-cuda | 42% | 25% | 25% | 17% | 0% | 0% | 17% | 17% | 25% | 23% |
| tts-llm-luna-lean-context | 100% | 100% | 100% | 33% | 88% | 100% | 83% | 100% | 100% | 80% |
| macbook-llm-haiku-lean-message-only | 67% | 88% | 38% | 33% | 100% | 0% | 0% | 83% | 88% | 31% |
| tts-llm-luna-lean-message-only | 58% | 88% | 25% | 50% | 100% | 100% | 0% | 100% | 88% | 51% |
| tts-llm-glm-deployed-message-only | 83% | 100% | 50% | 83% | 100% | 88% | 33% | 83% | 88% | 63% |
