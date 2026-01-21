(function () {
  'use strict';

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  // Expose model API instance for debugging
  window.vectaryModelApi = window.vectaryModelApi || null;

  // Cache for loaded 3D files (blobs)
  const fileCache = new Map();

  // Cache for imported objects (keyed by file URL)
  const objectCache = new Map();

  // Track currently visible material objects per application
  const activeMaterialObjects = new Map();

  // Debounce timer for rapid selections
  let debounceTimer = null;

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  /**
   * Debug logging utility (only logs when debug flag is set)
   */
  function debugLog(config, ...args) {
    if (config && config.debug) {
      // eslint-disable-next-line no-console
      console.log('[VectarySimple]', ...args);
    }
  }

  /**
   * Debounce function to prevent rapid-fire operations
   */
  function debounce(func, delay) {
    return function (...args) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => func.apply(this, args), delay);
    };
  }

  /**
   * Normalize string for comparison (lowercase, remove spaces/underscores)
   */
  function normalizeString(str) {
    return (str || '').toString().toLowerCase().replace(/[_\s]/g, '');
  }

  /**
   * Get object ID from various possible properties
   */
  function getObjectId(obj) {
    return obj && (obj.id || obj.uuid || obj.objectId || obj.instanceId);
  }

  // ============================================================================
  // CSV PARSING
  // ============================================================================

  /**
   * Parse CSV text into array of objects
   * Supports quoted fields and commas inside quotes
   */
  function parseCsv(text) {
    const rows = [];
    let current = [];
    let value = '';
    let inQuotes = false;

    function endValue() {
      current.push(value);
      value = '';
    }

    function endRow() {
      if (inQuotes) return;
      endValue();
      if (current.length && current.some(v => v !== '')) {
        rows.push(current);
      }
      current = [];
    }

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (ch === '"') {
        if (inQuotes && next === '"') {
          value += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        endValue();
      } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
        if (ch === '\r' && next === '\n') {
          i++;
        }
        endRow();
      } else {
        value += ch;
      }
    }

    if (value.length || current.length) {
      endValue();
      if (current.length && current.some(v => v !== '')) {
        rows.push(current);
      }
    }

    if (!rows.length) return [];
    const headers = rows[0].map(h => h.trim());
    const dataRows = rows.slice(1);
    return dataRows.map(cols => {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = (cols[idx] || '').trim();
      });
      return obj;
    });
  }

  /**
   * Load and parse materials CSV into a map keyed by material name
   */
  async function loadMaterialsCsv(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) {
      throw new Error(`Failed to load materials CSV: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    const rows = parseCsv(text);
    const byName = new Map();
    rows.forEach(row => {
      if (row.name) {
        byName.set(row.name, row);
      }
    });
    return { rows, byName };
  }

  // ============================================================================
  // VECTARY API INITIALIZATION
  // ============================================================================

  /**
   * Initialize the Vectary Model API for the given iframe id
   */
  async function initVectaryApi(iframeId, config) {
    let modelApi;
    let initPromise;

    if (window.VctrModelApi) {
      debugLog(config, 'Using existing window.VctrModelApi');
      modelApi = new window.VctrModelApi(iframeId);
      initPromise = modelApi.init();
    } else {
      debugLog(config, 'Importing Vectary API module');
      initPromise = import('https://www.vectary.com/studio-lite/scripts/api.js')
        .then(mod => {
          const Api = mod && (mod.VctrModelApi || (mod.default && mod.default.VctrModelApi));
          if (!Api) {
            throw new Error('Failed to obtain VctrModelApi from Vectary module');
          }
          modelApi = new Api(iframeId);
          return modelApi.init();
        });
    }

    await initPromise;
    debugLog(config, 'Vectary API initialized');
    return modelApi;
  }

  // ============================================================================
  // OBJECT MANAGEMENT
  // ============================================================================

  /**
   * Recursively flatten Vectary object hierarchy into a simple array
   * Handles nested API responses where objects can have `children`
   */
  function flattenObjectsRecursively(objects, flat) {
    const list = flat || [];
    (objects || []).forEach(obj => {
      if (!obj) return;
      list.push(obj);
      if (Array.isArray(obj.children) && obj.children.length) {
        flattenObjectsRecursively(obj.children, list);
      }
    });
    return list;
  }

  /**
   * Build an index from object name → array of objects (handles nested trees)
   */
  function buildObjectIndex(objects) {
    const flatObjects = flattenObjectsRecursively(objects || []);
    const byName = new Map();
    flatObjects.forEach(obj => {
      const name = (obj && obj.name) || '';
      if (!name) return;
      const list = byName.get(name) || [];
      list.push(obj);
      byName.set(name, list);
    });
    return byName;
  }

  /**
   * Hide objects by their IDs
   */
  async function hideObjects(modelApi, objectIds) {
    if (!objectIds || !objectIds.length) return;
    try {
      await modelApi.toggleVisibility(objectIds, false);
    } catch (err) {
      debugLog({ debug: true }, 'Error hiding objects:', err);
    }
  }

  /**
   * Show objects by their IDs
   */
  async function showObjects(modelApi, objectIds) {
    if (!objectIds || !objectIds.length) return;
    try {
      await modelApi.toggleVisibility(objectIds, true);
    } catch (err) {
      debugLog({ debug: true }, 'Error showing objects:', err);
    }
  }

  // ============================================================================
  // MATERIAL MATCHING
  // ============================================================================

  /**
   * Find a material matching target info from imported object
   * Uses multi-tier matching strategy for robustness
   */
  function findMatchingMaterial(importedObject, targetName, targetColor) {
    if (!importedObject || !importedObject.materials || !importedObject.materials.length) {
      return null;
    }

    const materials = importedObject.materials;
    const targetNorm = normalizeString(targetName);

    // Tier 1: Exact name match
    let match = materials.find(m => m.name === targetName);
    if (match) return match;

    // Tier 2: Normalized match
    match = materials.find(m => normalizeString(m.name) === targetNorm);
    if (match) return match;

    // Tier 3: Partial / suffix match
    match = materials.find(m => {
      const n = (m.name || '').toLowerCase();
      const t = (targetName || '').toLowerCase();
      return n.endsWith(t) || n.includes(t) || t.includes(n);
    });
    if (match) return match;

    // Tier 4: Color property match
    if (targetColor) {
      const colorLower = normalizeString(targetColor);
      match = materials.find(m => {
        const mc = normalizeString(m.color);
        return mc === colorLower;
      });
      if (match) return match;
    }

    // Tier 5: Short token match (e.g., "Corde4_pumpkin" → "pumpkin")
    if (targetColor && targetColor.includes('_')) {
      const shortToken = targetColor.split('_').pop().toLowerCase();
      match = materials.find(m => {
        const n = (m.name || '').toLowerCase();
        return n.includes(shortToken);
      });
      if (match) return match;
    }

    return null;
  }

  // ============================================================================
  // 3D FILE LOADING (WITH CACHING)
  // ============================================================================

  /**
   * Load a 3D file specified by CSV row and return the imported object
   * Implements caching to avoid re-loading the same file
   */
  async function loadMaterialObject(modelApi, csvRow, config) {
    const fileUrlFromDb = csvRow.download_link || csvRow._3d_file || '';
    if (!fileUrlFromDb) {
      throw new Error(`No download_link or _3d_file specified for material: ${csvRow.name || ''}`);
    }

    // Normalize file URL
    let fileUrl = fileUrlFromDb;
    if (!fileUrl.includes('://') && !fileUrl.startsWith('./')) {
      fileUrl = './vectary/3d_files/' + fileUrl;
    }

    // Check cache first
    if (objectCache.has(fileUrl)) {
      debugLog(config, 'Using cached object for material', csvRow.name);
      return objectCache.get(fileUrl);
    }

    debugLog(config, 'Loading 3D file for material', csvRow.name, 'from', fileUrl);

    // Get objects before import
    const beforeObjects = await modelApi.getObjects();
    const beforeIds = new Set(beforeObjects.map(getObjectId).filter(Boolean));

    // Fetch file (check cache first)
    let blob;
    if (fileCache.has(fileUrl)) {
      debugLog(config, 'Using cached file blob for', fileUrl);
      blob = fileCache.get(fileUrl);
    } else {
      const res = await fetch(fileUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch 3D file: ${fileUrl} (${res.status} ${res.statusText})`);
      }
      blob = await res.blob();
      fileCache.set(fileUrl, blob);
    }

    // Create file object
    const filename = csvRow._3d_file || (csvRow.name ? `${csvRow.name}.vctr3` : 'material.vctr3');
    const file = new File([blob], filename, { type: blob.type || 'model/vctr3' });

    // Import into Vectary
    await modelApi.importFiles(file, 2);

    // Find the newly imported object
    const afterObjects = await modelApi.getObjects();
    const imported = afterObjects.find(o => {
      const id = getObjectId(o);
      return id && !beforeIds.has(id);
    });

    if (!imported) {
      throw new Error(`Imported object not found after importing file: ${fileUrl}`);
    }

    // Cache the imported object
    objectCache.set(fileUrl, imported);
    debugLog(config, 'Imported and cached object for material', csvRow.name);

    return imported;
  }

  // ============================================================================
  // MATERIAL APPLICATION
  // ============================================================================

  /**
   * Apply a material to all configured objects for an application
   * Manages object visibility and caching
   */
  async function applyMaterial(modelApi, mapping, objectIndex, applicationName, optionLabel, materialsData, config) {
    const appMaterials = (mapping.materials && mapping.materials[applicationName]) || null;
    if (!appMaterials) {
      throw new Error(`No materials mapping found for application: ${applicationName}`);
    }

    const materialMapping = appMaterials[optionLabel];
    if (!materialMapping) {
      throw new Error(`No material mapping found for option "${optionLabel}" in application "${applicationName}"`);
    }

    const csvName = materialMapping.name;
    const csvColor = materialMapping.color;
    const csvRow = materialsData.byName.get(csvName);

    if (!csvRow) {
      throw new Error(`Material name "${csvName}" not found in materials CSV`);
    }

    // Hide previous material objects for this application
    const previousObjects = activeMaterialObjects.get(applicationName);
    if (previousObjects && previousObjects.length) {
      const previousIds = previousObjects.map(getObjectId).filter(Boolean);
      await hideObjects(modelApi, previousIds);
      debugLog(config, 'Hid previous material objects for', applicationName);
    }

    // Load the material object (cached if already loaded)
    const importedObject = await loadMaterialObject(modelApi, csvRow, config);

    // Find matching material
    let matchedMaterial = findMatchingMaterial(importedObject, csvColor || csvName, csvColor);
    if (!matchedMaterial) {
      if (importedObject.materials && importedObject.materials.length) {
        matchedMaterial = importedObject.materials[0];
        debugLog(
          config,
          'No exact material match found for',
          csvName,
          csvColor,
          '– falling back to first material:',
          matchedMaterial
        );
      } else {
        throw new Error(`No matching material found in imported object for "${csvName}" (${csvColor || ''})`);
      }
    }

    // Get target object names
    const targetObjectNames = (mapping.objectNames && mapping.objectNames[applicationName]) || [];
    if (!targetObjectNames.length) {
      throw new Error(`No target object names defined for application "${applicationName}"`);
    }

    // Apply material to all target objects
    let appliedCount = 0;
    const defaultMaterial =
      importedObject && importedObject.materials && importedObject.materials.length
        ? importedObject.materials[0]
        : matchedMaterial;

    const appliedObjectIds = [];

    for (const name of targetObjectNames) {
      const objs = objectIndex.get(name) || [];
      for (const obj of objs) {
        const id = getObjectId(obj);
        if (!id) continue;

        try {
          await modelApi.addOrEditMaterial(id, matchedMaterial);
          appliedCount++;
          appliedObjectIds.push(id);
        } catch (e) {
          debugLog(config, 'addOrEditMaterial failed for id', id, 'with matched material, trying default', e);
          if (defaultMaterial && defaultMaterial !== matchedMaterial) {
            try {
              await modelApi.addOrEditMaterial(id, defaultMaterial);
              appliedCount++;
              appliedObjectIds.push(id);
            } catch (e2) {
              // eslint-disable-next-line no-console
              console.error('Failed to apply both matched and default material for object', id, e2);
            }
          }
        }
      }
    }

    if (!appliedCount) {
      throw new Error(
        `Failed to apply material for application "${applicationName}". See earlier console errors from Vectary.`
      );
    }

    // Store active objects for this application
    activeMaterialObjects.set(applicationName, [importedObject]);

    debugLog(config, 'Applied material', matchedMaterial, 'to', appliedCount, 'objects for application', applicationName);
  }

  // ============================================================================
  // VARIANT APPLICATION
  // ============================================================================

  /**
   * Apply a variant selection (e.g., Lift height, Armrest)
   * Uses mapping.materials[applicationName][optionLabel].color as variant value
   */
  async function applyVariant(modelApi, mapping, objectIndex, applicationName, optionLabel, config) {
    const appMaterials = (mapping.materials && mapping.materials[applicationName]) || null;
    if (!appMaterials) {
      throw new Error(`No variant mapping found for application: ${applicationName}`);
    }

    const variantMapping = appMaterials[optionLabel];
    if (!variantMapping) {
      throw new Error(`No variant mapping found for option "${optionLabel}" in application "${applicationName}"`);
    }

    // The variant value should match the child object names in the switcher
    const variantValue = variantMapping.color || variantMapping.name || optionLabel;
    const targetObjectNames = (mapping.objectNames && mapping.objectNames[applicationName]) || [];

    if (!targetObjectNames.length) {
      throw new Error(`No variant object names defined for application "${applicationName}" in mapping.`);
    }

    // Read current configuration state
    const currentState = (await modelApi.getConfigurationState()) || [];
    const updatedState = Array.isArray(currentState) ? currentState.slice() : [];

    let matchedCount = 0;

    // Update variant configs
    updatedState.forEach(entry => {
      if (!entry) return;

      const variantName = entry.variant;
      if (variantName && targetObjectNames.includes(variantName)) {
        entry.active_object = variantValue;
        if (entry.active_object_instanceId) {
          delete entry.active_object_instanceId;
        }
        matchedCount++;
      }
    });

    if (!matchedCount) {
      debugLog(
        config,
        'No existing variant configs matched for application',
        applicationName,
        'targetObjectNames',
        targetObjectNames,
        'currentState',
        currentState
      );
      return;
    }

    debugLog(config, 'Applying variant', variantValue, 'for application', applicationName, 'on', matchedCount, 'config entries');

    await modelApi.setConfigurationState(updatedState);
  }

  // ============================================================================
  // APPLICATION TYPE DETECTION
  // ============================================================================

  /**
   * Determine if an application should be treated as a variant instead of a material
   */
  function isVariantApplication(applicationName) {
    const variants = ['lift', 'fabric_armrest'];
    return variants.includes((applicationName || '').toLowerCase());
  }

  // ============================================================================
  // UI HANDLING
  // ============================================================================

  /**
   * Show a simple, non-intrusive error message in the UI panel
   */
  function showErrorMessage(message) {
    const ui = document.getElementById('ui');
    if (!ui) return;

    let existing = ui.querySelector('.vectary-error');
    if (!existing) {
      existing = document.createElement('div');
      existing.className = 'vectary-error';
      existing.style.cssText =
        'background: #fdecea; border-left: 4px solid #f44336; padding: 10px; margin-bottom: 15px; border-radius: 4px; font-size: 12px; color: #b71c1c;';
      ui.insertBefore(existing, ui.children[1] || null);
    }
    existing.textContent = message;

    // Auto-hide after 5 seconds
    setTimeout(() => {
      if (existing && existing.parentElement) {
        existing.parentElement.removeChild(existing);
      }
    }, 5000);
  }

  /**
   * Show a success message (optional, for user feedback)
   */
  function showSuccessMessage(message) {
    const ui = document.getElementById('ui');
    if (!ui) return;

    let existing = ui.querySelector('.vectary-success');
    if (!existing) {
      existing = document.createElement('div');
      existing.className = 'vectary-success';
      existing.style.cssText =
        'background: #e8f5e9; border-left: 4px solid #4caf50; padding: 10px; margin-bottom: 15px; border-radius: 4px; font-size: 12px; color: #2e7d32;';
      ui.insertBefore(existing, ui.children[1] || null);
    }
    existing.textContent = message;

    setTimeout(() => {
      if (existing && existing.parentElement) {
        existing.parentElement.removeChild(existing);
      }
    }, 3000);
  }

  /**
   * Bind change listeners to all select elements inside the options container
   * Includes debouncing to prevent rapid-fire operations
   */
  function bindUiHandlers(modelApi, mapping, materialsData, objectIndex, config) {
    const container = document.getElementById('vectary-options-container');
    if (!container) return;

    // Debounced handler to prevent rapid selections
    const debouncedHandler = debounce(async function (event) {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) {
        return;
      }

      const applicationName = target.getAttribute('data-application');
      const rawValue = target.value;
      if (!applicationName || !rawValue) {
        return;
      }

      // Show loading state
      const originalValue = target.value;
      target.disabled = true;
      target.style.opacity = '0.6';

      try {
        if (isVariantApplication(applicationName)) {
          await applyVariant(modelApi, mapping, objectIndex, applicationName, rawValue, config);
        } else {
          await applyMaterial(modelApi, mapping, objectIndex, applicationName, rawValue, materialsData, config);
        }
        // Optional: show success message
        // showSuccessMessage(`Applied "${rawValue}" successfully`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Error applying selection for', applicationName, rawValue, err);
        showErrorMessage(`Unable to apply "${rawValue}" for "${applicationName}". See console for details.`);
        // Restore original value on error
        target.value = originalValue;
      } finally {
        target.disabled = false;
        target.style.opacity = '1';
      }
    }, 300); // 300ms debounce

    container.addEventListener('change', debouncedHandler);
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Entry point: initialize everything once DOM is ready
   */
  async function init() {
    const mapping = window.freedomChairMapping;
    const config = window.vectaryConfig;

    if (!mapping || !config) {
      // eslint-disable-next-line no-console
      console.error('freedomChairMapping or vectaryConfig is not defined on window.');
      return;
    }

    try {
      const iframeId = config.iframeId;
      const iframe = document.getElementById(iframeId);
      if (!iframe) {
        throw new Error(`Iframe with id "${iframeId}" not found.`);
      }

      // Show loading state
      const loadingEl = document.querySelector('#vectary-options-container .loading');
      if (loadingEl) {
        loadingEl.textContent = 'Initializing 3D configurator...';
      }

      // Initialize Vectary API
      const modelApi = await initVectaryApi(iframeId, config);

      // Expose globally for debugging
      window.vectaryModelApi = modelApi;
      window.inspectVectaryAPI =
        window.inspectVectaryAPI ||
        (async function () {
          const objects = await modelApi.getObjects();
          const configState = await modelApi.getConfigurationState();
          return { objects, configState, fileCache, objectCache, activeMaterialObjects };
        });

      // Load materials CSV and get objects in parallel
      const [materialsData, objects] = await Promise.all([
        loadMaterialsCsv(config.materialsCsvUrl),
        modelApi.getObjects(),
      ]);

      const objectIndex = buildObjectIndex(objects);
      debugLog(config, 'Initial objects index', objectIndex);

      // Clear loading message
      if (loadingEl && loadingEl.parentElement) {
        loadingEl.parentElement.removeChild(loadingEl);
      }

      // Bind UI handlers
      bindUiHandlers(modelApi, mapping, materialsData, objectIndex, config);
      debugLog(config, 'Vectary simple configurator initialized');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to initialize Vectary simple configurator', err);
      showErrorMessage('Failed to initialize 3D configurator. Please reload the page and check the browser console.');
    }
  }

  // Start initialization when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
