export default function LoadingSpinner({ label = "Loading..." }) {
  return (
    <div className="loadingScreen" role="status" aria-live="polite">
      <div className="loadingBounce" aria-hidden="true">
        <div className="loadingBall" />
        <div className="loadingBallShadow" />
      </div>
      <span>{label}</span>
    </div>
  );
}
