"""Fake backend so R1 (hex grid, fog of war, ghost tokens) is buildable
and testable without a camera. Swap for a real VisionBackend later."""

from .base import Detection, VisionBackend


class MockVisionBackend(VisionBackend):
    def __init__(self, frame_size: tuple[int, int] = (1280, 720)) -> None:
        self._frame_size = frame_size
        self._fixtures: list[Detection] = []

    def set_fixtures(self, detections: list[Detection]) -> None:
        """Test/dev hook: control exactly what the next process_frame returns."""
        self._fixtures = detections

    def process_frame(self, frame_bytes: bytes) -> list[Detection]:
        return list(self._fixtures)

    def get_frame_size(self) -> tuple[int, int] | None:
        return self._frame_size
