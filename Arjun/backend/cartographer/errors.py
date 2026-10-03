"""Errors shared by API, validation and provider boundaries."""


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, field: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.field = field

    def as_dict(self) -> dict:
        error = {"code": self.code, "message": self.message}
        if self.field:
            error["field"] = self.field
        return {"error": error}
