from flask import Flask, request, jsonify
import uuid
import threading
from services.imagery_service import ImageryService

app = Flask(__name__)
imagery_service = ImageryService()

# In a real app, this would be a database or Redis queue (like Celery)
# to handle long-running geographic search tasks.
ACTIVE_JOBS = {}

def process_search_job(job_id, lat, lng, query):
    """
    Background worker that runs the Cartographer pipeline for a single point.
    In the real app, this would iterate over MANY points in a geographic bounds.
    """
    ACTIVE_JOBS[job_id] = {"status": "fetching_imagery", "progress": 10, "detections": []}
    
    # 1. Street-Level Imagery Acquisition
    print(f"[Job {job_id}] Acquiring 360 imagery for {lat}, {lng}...")
    image_paths = imagery_service.acquire_360_panorama(lat, lng, job_id)
    
    if not image_paths:
        ACTIVE_JOBS[job_id]["status"] = "completed"
        ACTIVE_JOBS[job_id]["progress"] = 100
        ACTIVE_JOBS[job_id]["error"] = "No street view imagery available at this location."
        return

    ACTIVE_JOBS[job_id]["status"] = "running_vision_models"
    ACTIVE_JOBS[job_id]["progress"] = 50
    
    # 2. Visual Analysis (Mocked)
    # Here is where the vision_service.py would load `image_paths` and look for `query`
    print(f"[Job {job_id}] Running computer vision to find '{query}' in {len(image_paths)} images...")
    
    # 3. Geolocated Detections (Mocked result)
    mock_detection = {
        "id": str(uuid.uuid4()),
        "type": query,
        "coordinates": {"lat": lat, "lng": lng},
        "confidence": 0.92,
        "source_image": image_paths[0] # Link to the image where it was found
    }
    
    ACTIVE_JOBS[job_id]["detections"].append(mock_detection)
    ACTIVE_JOBS[job_id]["status"] = "completed"
    ACTIVE_JOBS[job_id]["progress"] = 100
    print(f"[Job {job_id}] Job complete.")


@app.route("/api/search", methods=["POST"])
def start_search():
    """
    API Boundary: React Frontend tells Flask to start looking.
    User Query -> Geographic Search Area
    """
    data = request.json
    query = data.get("query") # e.g., "bicycle racks"
    
    # In a full app, this would be a bounding box or route. 
    # For now, we mock it with a single coordinate.
    lat = data.get("lat") 
    lng = data.get("lng")
    
    job_id = str(uuid.uuid4())
    
    # Start the long-running search in the background
    thread = threading.Thread(target=process_search_job, args=(job_id, lat, lng, query))
    thread.start()
    
    # Immediately return the Job ID so React can start polling for progress
    return jsonify({
        "job_id": job_id,
        "status": "started",
        "message": f"Started searching for '{query}'"
    }), 202

@app.route("/api/search/<job_id>", methods=["GET"])
def get_search_status(job_id):
    """
    API Boundary: React Frontend polls for progress and progressive results.
    """
    job = ACTIVE_JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
        
    return jsonify(job), 200

if __name__ == "__main__":
    app.run(debug=True, port=5000)

