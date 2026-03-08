import mascot from '../../assets/images/empanadash/mascot.png';
import { Button } from '@/components/ui/button';
import { motion, type Variants } from 'framer-motion';
import { useTheme } from '@/hooks/useTheme';

interface WelcomeScreenProps {
  onGetStarted: () => void;
}

export function WelcomeScreen({ onGetStarted }: WelcomeScreenProps) {
  const { effectiveTheme } = useTheme();

  const containerVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.3,
        delayChildren: 0.7,
      },
    },
  };

  const itemVariants: Variants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.9,
        ease: [0.25, 0.1, 0.25, 1] as [number, number, number, number], // Properly typed cubic-bezier
      },
    },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <motion.div
        className="relative z-10 flex flex-col items-center justify-center space-y-4 p-8"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <motion.div variants={itemVariants}>
          <img src={mascot} alt="empanadash" className="h-24 w-24" />
        </motion.div>

        <motion.h1
          className="text-lg font-semibold tracking-tight text-foreground"
          variants={itemVariants}
        >
          Welcome.
        </motion.h1>

        <motion.div
          variants={itemVariants}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          transition={{ duration: 0.1, ease: 'easeInOut' }}
        >
          <Button
            onClick={onGetStarted}
            size="sm"
            className={
              effectiveTheme === 'dark-black' ? 'bg-gray-200 text-gray-900 hover:bg-gray-300' : ''
            }
          >
            Start shipping
          </Button>
        </motion.div>
      </motion.div>
    </div>
  );
}
