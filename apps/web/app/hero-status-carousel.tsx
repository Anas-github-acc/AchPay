'use client';

import {
  AnimatePresence,
  motion,
  type HTMLMotionProps,
  type Transition,
  useReducedMotion,
} from 'motion/react';
import * as React from 'react';

type RotatingTextProps = {
  text: string | string[];
  duration?: number;
  transition?: Transition;
  y?: number;
  containerClassName?: string;
} & HTMLMotionProps<'div'>;

function RotatingText({
  text,
  y = -50,
  duration = 3200,
  transition = { duration: 0.3, ease: 'easeOut' },
  containerClassName,
  ...props
}: RotatingTextProps) {
  const [index, setIndex] = React.useState(0);
  const [isPaused, setIsPaused] = React.useState(false);
  const prefersReducedMotion = useReducedMotion();
  const items = Array.isArray(text) ? text : [text];

  React.useEffect(() => {
    if (items.length < 2 || isPaused || prefersReducedMotion) return;

    const interval = window.setInterval(() => {
      setIndex((previousIndex) => (previousIndex + 1) % items.length);
    }, duration);

    return () => window.clearInterval(interval);
  }, [duration, isPaused, items.length, prefersReducedMotion]);

  const currentText = items[index] ?? items[0];
  const animationTransition = prefersReducedMotion ? { duration: 0 } : transition;

  return (
    <div
      className={`rotating-text ${containerClassName ?? ''}`}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsPaused(false);
        }
      }}
    >
      <AnimatePresence mode="wait">
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y }}
          initial={{ opacity: 0, y: -y }}
          key={currentText}
          transition={animationTransition}
          {...props}
        >
          {currentText}
        </motion.div>
      </AnimatePresence>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {currentText}
      </span>
    </div>
  );
}

export { RotatingText, type RotatingTextProps };
export default RotatingText;
