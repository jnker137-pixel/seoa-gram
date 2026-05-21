import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; fallback?: ReactNode; }
interface State { error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ?? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-3">
          <p className="text-2xl">⚠️</p>
          <p className="text-gray-600 font-medium">화면을 불러오지 못했어</p>
          <p className="text-sm text-gray-400">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-2 px-4 py-2 bg-gray-800 text-white rounded-xl text-sm"
          >
            다시 시도
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
