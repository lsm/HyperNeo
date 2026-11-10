---
id: neo.coding.merge.retry
---
Neo accepts a stopped daemon merge report for an exact PR head after every fresh merge gate passes. Reopens its three-attempt budget without deleting historical failures or changing preferences. Does not merge; the daemon checks all gates again on its next sweep.
