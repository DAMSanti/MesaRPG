from typing import Optional, List, Dict, Any, ClassVar
from pydantic import BaseModel, Field, ConfigDict


class MapTile(BaseModel):
    x: int
    y: int
    tileId: str
    
    # Pydantic v2 config placeholder to avoid class-based `Config` deprecation
    model_config: ClassVar[ConfigDict] = ConfigDict()


class MapMeta(BaseModel):
    id: Optional[str]
    name: str
    width: int
    height: int
    type: Optional[str]
    seed: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    
    model_config: ClassVar[ConfigDict] = ConfigDict()


class MapModel(BaseModel):
    id: Optional[str] = None
    name: str = Field(default="Mapa sin nombre")
    width: int = Field(default=20)
    height: int = Field(default=15)
    gridType: str = Field(default="square")
    cellSize: float = Field(default=32.0)
    tiles: List[MapTile] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    seed: Optional[str] = None
    type: str = Field(default="custom")
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    model_config: ClassVar[ConfigDict] = ConfigDict()


class TokenTouch(BaseModel):
    tokenId: Optional[str]
    x: float
    y: float
    pressure: Optional[float]
    timestamp: Optional[str]

    model_config: ClassVar[ConfigDict] = ConfigDict()
