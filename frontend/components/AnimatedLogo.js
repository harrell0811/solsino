import Image from 'next/image';

export default function AnimatedLogo({ size = 56 }) {
  return (
    <div className="logo-wrap" style={{ width: size, height: size }}>
      <div className="logo-glow" />
      <div className="logo-ring" />
      <div className="logo-core">
        <Image
          src="/logo.png"
          alt="Solsino"
          width={size}
          height={size}
          priority
          className="logo-img"
        />
      </div>
      <div className="logo-spark logo-spark-1" />
      <div className="logo-spark logo-spark-2" />
      <div className="logo-spark logo-spark-3" />
    </div>
  );
}
