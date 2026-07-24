import { useCallback, useRef } from 'react';
import { driver, type DriveStep, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { DEMO_AGENT_PROMPT, DEMO_STEPS } from './demoSteps';

export type DemoTourView = 'projects' | 'tasks' | 'agent' | 'search' | 'help' | 'about';

export interface UseDemoTourOptions {
  setView: (view: DemoTourView) => void;
  onSetDemoPrompt: (prompt: string | null) => void;
  onComplete: () => void | Promise<void>;
  autoApproveProposals?: boolean;
}

async function waitForElement(selector: string, attempts = 40): Promise<Element | null> {
  for (let i = 0; i < attempts; i += 1) {
    const element = document.querySelector(selector);
    if (element) return element;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function approvalDescription(autoApproveProposals: boolean): string {
  if (autoApproveProposals) {
    return 'When auto-approve is enabled, agent write actions apply immediately. You can still reject proposals from the bar at the bottom of the agent panel.';
  }
  return 'After you send a message, write actions appear in a Pending approval bar at the bottom of this panel. Approve or reject before changes apply.';
}

export function useDemoTour({
  setView,
  onSetDemoPrompt,
  onComplete,
  autoApproveProposals = false,
}: UseDemoTourOptions) {
  const driverRef = useRef<Driver | null>(null);
  const runningRef = useRef(false);

  const destroyTour = useCallback(() => {
    driverRef.current?.destroy();
    driverRef.current = null;
    runningRef.current = false;
    onSetDemoPrompt(null);
  }, [onSetDemoPrompt]);

  const prepareStep = useCallback(
    async (stepIndex: number) => {
      const step = DEMO_STEPS[stepIndex];
      if (!step) return false;

      if (step.view) {
        setView(step.view);
      }

      if (step.prefillAgentPrompt) {
        onSetDemoPrompt(DEMO_AGENT_PROMPT);
      }

      const element = await waitForElement(step.selector);
      return Boolean(element);
    },
    [onSetDemoPrompt, setView]
  );

  const startTour = useCallback(async () => {
    if (runningRef.current) {
      destroyTour();
    }
    runningRef.current = true;

    await prepareStep(0);

    const steps: DriveStep[] = DEMO_STEPS.map((step, index) => ({
      element: step.selector,
      popover: {
        title: step.title,
        description:
          step.id === 'approval' ? approvalDescription(autoApproveProposals) : step.description,
        side: step.side ?? 'bottom',
        align: 'start' as const,
        onNextClick: (_element, _step, { driver: activeDriver }) => {
          void (async () => {
            const nextIndex = index + 1;
            if (nextIndex >= DEMO_STEPS.length) {
              activeDriver.destroy();
              return;
            }
            await prepareStep(nextIndex);
            activeDriver.moveNext();
          })();
        },
      },
    }));

    const driverObj = driver({
      showProgress: true,
      progressText: '{{current}} of {{total}}',
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      doneBtnText: 'Done',
      allowClose: true,
      overlayOpacity: 0.55,
      stagePadding: 8,
      steps,
      onDestroyStarted: () => {
        void onComplete();
        onSetDemoPrompt(null);
        runningRef.current = false;
        driverRef.current = null;
      },
    });

    driverRef.current = driverObj;
    driverObj.drive();
  }, [autoApproveProposals, destroyTour, onComplete, onSetDemoPrompt, prepareStep]);

  return { startTour, destroyTour };
}
