import { describe, expect, it } from 'vitest';
import {
  getReconnectSkipReason,
  isLifecycleSuperseded,
  nextLifecycleEpoch,
  shouldHideConsoleWindow,
} from '@electron/gateway/process-policy';

describe('gateway process policy helpers', () => {
  describe('shouldHideConsoleWindow', () => {
    it('returns true on Windows', () => {
      expect(shouldHideConsoleWindow('win32')).toBe(true);
    });

    it('returns false on non-Windows platforms', () => {
      expect(shouldHideConsoleWindow('darwin')).toBe(false);
      expect(shouldHideConsoleWindow('linux')).toBe(false);
    });
  });

  describe('lifecycle epoch helpers', () => {
    it('increments lifecycle epoch by one', () => {
      expect(nextLifecycleEpoch(0)).toBe(1);
      expect(nextLifecycleEpoch(5)).toBe(6);
    });

    it('detects superseded lifecycle epochs', () => {
      expect(isLifecycleSuperseded(3, 4)).toBe(true);
      expect(isLifecycleSuperseded(8, 8)).toBe(false);
    });
  });

  describe('getReconnectSkipReason', () => {
    it('skips reconnect when auto-reconnect is disabled', () => {
      expect(
        getReconnectSkipReason({
          scheduledEpoch: 10,
          currentEpoch: 10,
          shouldReconnect: false,
        })
      ).toBe('auto-reconnect disabled');
    });

    it('skips stale reconnect callbacks when lifecycle epoch changed', () => {
      expect(
        getReconnectSkipReason({
          scheduledEpoch: 11,
          currentEpoch: 12,
          shouldReconnect: true,
        })
      ).toContain('stale reconnect callback');
    });

    it('allows reconnect when callback is current and reconnect enabled', () => {
      expect(
        getReconnectSkipReason({
          scheduledEpoch: 7,
          currentEpoch: 7,
          shouldReconnect: true,
        })
      ).toBeNull();
    });
  });
});
