"""Contract every vision backend must satisfy (ROADMAP.md Fase R0).

Two implementations are expected over time: OpenVINO/x86 (dev machine,
wraps the already-trained pipeline in server/frame_processor.py) and
Hailo/ARM (Raspberry Pi target hardware, needs a physical Pi to build
against — not done here, see ROADMAP.md). Neither is wired up in this
session: no camera hardware to test against. What's here is the seam
that lets R1 (hex grid, fog of war, ghost tokens) be built and tested
today against MockVisionBackend, then swapped for a real one later
without touching any of the code that consumes detections.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class Detection:
    track_id: int
    x: float
    y: float
    heading_deg: float | None
    confidence: float


class VisionBackend(ABC):
    @abstractmethod
    def process_frame(self, frame_bytes: bytes) -> list[Detection]: ...

    @abstractmethod
    def get_frame_size(self) -> tuple[int, int] | None: ...
