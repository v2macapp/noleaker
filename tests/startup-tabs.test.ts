import { expect, it } from 'vitest';
import { noteStartupError, takeStartupErrors } from '../src/background/startup-tabs';

it('keeps main-frame failures until taken, then stops recording (B3)', () => {
  noteStartupError({ tabId: 1, frameId: 0, error: 'net::ERR_BLOCKED_BY_CLIENT' });
  noteStartupError({ tabId: 1, frameId: 0, error: 'net::ERR_BLOCKED_BY_CLIENT' });
  noteStartupError({ tabId: 2, frameId: 3, error: 'net::ERR_BLOCKED_BY_CLIENT' }); // a subframe
  noteStartupError({ tabId: 4, frameId: 0, error: 'net::ERR_ABORTED' }); // the user stopped it
  noteStartupError({ tabId: 5, frameId: 0, error: 'NS_BINDING_ABORTED' });
  noteStartupError({ tabId: 6, frameId: 0, error: 'NS_ERROR_CONNECTION_REFUSED' });
  expect(takeStartupErrors()).toEqual([1, 6]);
  noteStartupError({ tabId: 7, frameId: 0, error: 'net::ERR_BLOCKED_BY_CLIENT' });
  expect(takeStartupErrors()).toEqual([]);
});
