import { describe, it, expect, vi } from 'vitest';
import {
  RenderLoopController,
  VisibilitySource,
} from '../../src/renderer/cad-viewport';

class FakeVisibilitySource implements VisibilitySource {
  public isVisible = true;
  private listeners: Array<() => void> = [];

  addEventListener(_event: 'visibilitychange', handler: () => void): void {
    this.listeners.push(handler);
  }

  removeEventListener(_event: 'visibilitychange', handler: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== handler);
  }

  setVisibility(visible: boolean): void {
    this.isVisible = visible;
    for (const listener of this.listeners) {
      listener();
    }
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

describe('RenderLoopController (Visibility & Context-Loss)', () => {
  it('starts running when initialized with visible source', () => {
    const fakeVis = new FakeVisibilitySource();
    const onStart = vi.fn();
    const onStop = vi.fn();

    const controller = new RenderLoopController(onStart, onStop, fakeVis);

    expect(controller.isRunning()).toBe(true);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('pauses render loop when visibility changes to hidden (document minimized/hidden)', () => {
    const fakeVis = new FakeVisibilitySource();
    const onStart = vi.fn();
    const onStop = vi.fn();

    const controller = new RenderLoopController(onStart, onStop, fakeVis);

    fakeVis.setVisibility(false);

    expect(controller.isRunning()).toBe(false);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('resumes render loop when visibility changes from hidden to visible', () => {
    const fakeVis = new FakeVisibilitySource();
    fakeVis.isVisible = false;
    const onStart = vi.fn();
    const onStop = vi.fn();

    const controller = new RenderLoopController(onStart, onStop, fakeVis);
    expect(controller.isRunning()).toBe(false);

    fakeVis.setVisibility(true);

    expect(controller.isRunning()).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('pauses render loop on context loss even when visible, and resumes on restore', () => {
    const fakeVis = new FakeVisibilitySource();
    const onStart = vi.fn();
    const onStop = vi.fn();

    const controller = new RenderLoopController(onStart, onStop, fakeVis);

    // Lose context
    controller.setContextLost(true);
    expect(controller.isRunning()).toBe(false);
    expect(onStop).toHaveBeenCalledTimes(1);

    // Restore context
    controller.setContextLost(false);
    expect(controller.isRunning()).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('does NOT resume on context restore if visibility remains hidden', () => {
    const fakeVis = new FakeVisibilitySource();
    const onStart = vi.fn();
    const onStop = vi.fn();

    const controller = new RenderLoopController(onStart, onStop, fakeVis);

    // Hide window
    fakeVis.setVisibility(false);
    expect(onStop).toHaveBeenCalledTimes(1);

    // Lose and restore context while hidden
    controller.setContextLost(true);
    controller.setContextLost(false);

    // Still hidden, so must NOT start
    expect(controller.isRunning()).toBe(false);
    expect(onStart).not.toHaveBeenCalled();

    // Now reveal window -> resumes
    fakeVis.setVisibility(true);
    expect(controller.isRunning()).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('cleans up event listeners on dispose', () => {
    const fakeVis = new FakeVisibilitySource();
    const onStart = vi.fn();
    const onStop = vi.fn();

    const controller = new RenderLoopController(onStart, onStop, fakeVis);
    expect(fakeVis.listenerCount).toBe(1);

    controller.dispose();
    expect(fakeVis.listenerCount).toBe(0);
  });
});
