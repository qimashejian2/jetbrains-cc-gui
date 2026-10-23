import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface WaitingIndicatorProps {
  label?: string;
  size?: number;
  /** Loading start timestamp (ms), used to maintain continuous timing across view switches */
  startTime?: number;
  showElapsed?: boolean;
}

export const WaitingIndicator = ({ size = 18, startTime, label, showElapsed = true }: WaitingIndicatorProps) => {
  const { t } = useTranslation();
  const [dotCount, setDotCount] = useState(1);
  const [elapsedSeconds, setElapsedSeconds] = useState(() => {
    // If a start time is provided, calculate the elapsed seconds
    if (startTime !== undefined) {
      return Math.floor((Date.now() - startTime) / 1000);
    }
    return 0;
  });

  // Ellipsis animation
  useEffect(() => {
    const timer = setInterval(() => {
      setDotCount(prev => (prev % 3) + 1);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // Timer: track elapsed seconds for the current thinking round
  useEffect(() => {
    if (!showElapsed) return;
    const updateElapsed = () => {
      if (startTime !== undefined) {
        setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
      } else {
        setElapsedSeconds(prev => prev + 1);
      }
    };
    if (startTime !== undefined) updateElapsed();
    const timer = setInterval(() => {
      // Calculate from the supplied start time to avoid reset on view switches.
      updateElapsed();
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [showElapsed, startTime]);

  const dots = '.'.repeat(dotCount);

  const spinnerStyle: React.CSSProperties = { width: size, height: size };

  // Format elapsed time: show "X seconds" under 60s, "X min Y sec" above 60s
  const formatElapsedTime = (seconds: number): string => {
    if (seconds < 60) {
      return `${seconds} ${t('common.seconds')}`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${t('chat.minutesAndSeconds', { minutes, seconds: remainingSeconds })}`;
  };

  return (
    <div className="waiting-indicator">
      <span className="waiting-spinner" style={spinnerStyle} />
      <span className="waiting-text">
	        {label ?? t('chat.generatingResponse')}<span className="waiting-dots">{dots}</span>
        {showElapsed && <span className="waiting-seconds">（{t('chat.elapsedTime', { time: formatElapsedTime(elapsedSeconds) })}）</span>}
      </span>
    </div>
  );
};

export default WaitingIndicator;

