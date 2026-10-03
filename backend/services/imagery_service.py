import os
import requests
from dotenv import load_dotenv

load_dotenv()

class ImageryService:
    """
    Handles the acquisition of street-level imagery for Cartographer.
    This corresponds to the 'Street-Level Imagery' step in the pipeline:
    User Query -> Geographic Area -> [Street-Level Imagery] -> Visual Analysis
    """
    
    def __init__(self):
        self.api_key = os.getenv("GOOGLE_MAPS_API_KEY")
        self.base_url = "https://maps.googleapis.com/maps/api/streetview"
        
        if not self.api_key:
            print("WARNING: GOOGLE_MAPS_API_KEY not found in environment.")

    def get_street_view_image(self, location: str, output_filename: str, heading: int = None, pitch: int = 0, fov: int = 90) -> bool:
        """
        Fetches a single Street View image from the Google Maps Static API.
        Returns True if successful, False if no imagery is found.
        """
        params = {
            "size": "600x600", # Square images are often better for CV models
            "location": location,
            "key": self.api_key,
            "pitch": pitch,
            "fov": fov,
            "return_error_code": "true" # Crucial for failing fast on oceans/unmapped areas
        }
        
        if heading is not None:
            params["heading"] = heading
            
        try:
            response = requests.get(self.base_url, params=params, timeout=10)
            
            if response.status_code == 200:
                with open(output_filename, 'wb') as file:
                    file.write(response.content)
                return True
            elif response.status_code == 404:
                # No imagery available at this specific location/heading
                return False
            else:
                print(f"ImageryService API Error: {response.status_code} - {response.text}")
                return False
        except requests.RequestException as e:
            print(f"ImageryService Request Failed: {e}")
            return False

    def acquire_360_panorama(self, lat: float, lng: float, job_id: str) -> list[str]:
        """
        Acquires a full 360-degree sweep at the given coordinates.
        Saves images to a job-specific folder and returns the list of file paths
        so the Visual Analysis service can immediately process them.
        """
        coords_str = f"{lat},{lng}"
        
        # We store imagery temporarily per-search-job for the vision models
        output_folder = os.path.join("backend", "data", "jobs", job_id, f"{lat}_{lng}")
        os.makedirs(output_folder, exist_ok=True)
        
        # 8 angles provides a seamless 360 sweep with good overlap for object detection
        headings = [0, 45, 90, 135, 180, 225, 270, 315]
        saved_files = []
        
        # Always check heading 0 first to ensure the location actually has street view
        first_filename = os.path.join(output_folder, "view_000_deg.jpg")
        if not self.get_street_view_image(coords_str, first_filename, heading=0):
            # If 0 fails with 404, the Google car never drove here (e.g. Atlantic Ocean)
            return []
            
        saved_files.append(first_filename)
        
        # Acquire the remaining 7 angles
        for heading in headings[1:]:
            filename = os.path.join(output_folder, f"view_{heading:03d}_deg.jpg")
            if self.get_street_view_image(coords_str, filename, heading=heading):
                saved_files.append(filename)
                
        return saved_files

