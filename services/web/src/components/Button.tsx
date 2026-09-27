import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  children?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:   'bg-[#1B4E9B] text-white hover:bg-[#16407F] disabled:bg-[#CBD5E1] disabled:text-white',
  secondary: 'bg-white text-[#0F172A] border border-[#CBD5E1] hover:bg-[#F5F7FA] disabled:text-[#94A3B8]',
  ghost:     'bg-transparent text-[#1B4E9B] hover:bg-[#E8F0FB] disabled:text-[#94A3B8]',
  danger:    'bg-[#B42318] text-white hover:bg-[#912018] disabled:bg-[#CBD5E1]'
};

const sizes: Record<Size, string> = {
  md: 'h-9 px-4 text-[13px]',
  lg: 'h-10 px-5 text-[14px]'
};

export default function Button({
  variant = 'primary',
  size = 'md',
  icon,
  children,
  className = '',
  ...rest
}: Props) {
  return (
    <button
      {...rest}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors',
        'disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className
      ].join(' ')}
    >
      {icon}
      {children}
    </button>
  );
}