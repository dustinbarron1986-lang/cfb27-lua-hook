local TAG = "[live-actor-collection]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function safe_u8(addr)
    local ok, value = pcall(cfb.read_u8, addr)
    if not ok then
        return nil
    end
    return value
end

local function read_u32(addr)
    local b0 = safe_u8(addr)
    local b1 = safe_u8(addr + 1)
    local b2 = safe_u8(addr + 2)
    local b3 = safe_u8(addr + 3)

    if b0 == nil or b1 == nil or b2 == nil or b3 == nil then
        return nil
    end

    return b0
        | (b1 << 8)
        | (b2 << 16)
        | (b3 << 24)
end

local function read_u64(addr)
    local value = 0

    for i = 7, 0, -1 do
        local b = safe_u8(addr + i)
        if b == nil then
            return nil
        end
        value = (value << 8) | b
    end

    return value
end

local function is_probable_ptr(v)
    if v == nil then
        return false
    end

    -- Typical 64-bit user-mode address range; intentionally permissive.
    return v >= 0x10000 and v < 0x0000800000000000
end

local function readable_qword(addr)
    if not is_probable_ptr(addr) then
        return false
    end
    return read_u64(addr) ~= nil
end

local function summarize_entry_array(base_ptr, count, stride, label)
    if not is_probable_ptr(base_ptr) or count ~= 11 then
        return
    end

    local readable = 0
    local pointer_heads = 0
    local unique_heads = {}
    local samples = {}

    for i = 0, count - 1 do
        local addr = base_ptr + (i * stride)
        local head = read_u64(addr)

        if head ~= nil then
            readable = readable + 1

            if is_probable_ptr(head) and readable_qword(head) then
                pointer_heads = pointer_heads + 1
                unique_heads[string.format("%X", head)] = true
            end

            if #samples < 4 then
                samples[#samples + 1] = string.format(
                    "%d:0x%X",
                    i,
                    head
                )
            end
        end
    end

    local unique_count = 0
    for _ in pairs(unique_heads) do
        unique_count = unique_count + 1
    end

    log(string.format(
        "ARRAY_SUMMARY label=%s base=0x%X count=%d stride=%d readable=%d pointer_heads=%d unique_pointer_heads=%d samples=%s",
        label,
        base_ptr,
        count,
        stride,
        readable,
        pointer_heads,
        unique_count,
        table.concat(samples, ",")
    ))
end

local stride_candidates = {
    8, 16, 24, 32, 40, 48, 56, 64,
    72, 80, 88, 96, 104, 112, 120, 128,
    144, 160, 176, 192, 224, 256
}

local function inspect_object(label, obj, window)
    if not readable_qword(obj) then
        log(string.format(
            "OBJECT_UNREADABLE label=%s addr=0x%X",
            label,
            obj
        ))
        return 0
    end

    log(string.format(
        "OBJECT label=%s addr=0x%X window=0x%X",
        label,
        obj,
        window
    ))

    local candidates = 0

    for off = 0, window, 8 do
        local a = read_u64(obj + off)
        local b = read_u64(obj + off + 8)
        local c = read_u64(obj + off + 16)

        -- pointer + qword count
        if is_probable_ptr(a) and b == 11 then
            candidates = candidates + 1

            log(string.format(
                "CANDIDATE kind=PTR_COUNT64 object=%s offset=0x%X ptr=0x%X count=11",
                label,
                off,
                a
            ))

            summarize_entry_array(
                a,
                11,
                8,
                label .. string.format("+0x%X/PTR_COUNT64", off)
            )
        end

        -- pointer + 32-bit count at +8
        local b32 = read_u32(obj + off + 8)
        if is_probable_ptr(a) and b32 == 11 then
            candidates = candidates + 1

            log(string.format(
                "CANDIDATE kind=PTR_COUNT32 object=%s offset=0x%X ptr=0x%X count=11",
                label,
                off,
                a
            ))

            summarize_entry_array(
                a,
                11,
                8,
                label .. string.format("+0x%X/PTR_COUNT32", off)
            )
        end

        -- vector-like begin/end/capacity. Retain only exact 11-entry arithmetic
        -- for a short list of plausible entry sizes.
        if is_probable_ptr(a)
            and is_probable_ptr(b)
            and is_probable_ptr(c)
            and b >= a
            and c >= b
            and (c - a) < 0x100000
        then
            local span = b - a

            for _, stride in ipairs(stride_candidates) do
                if span == (11 * stride) then
                    candidates = candidates + 1

                    log(string.format(
                        "CANDIDATE kind=VECTOR11 object=%s offset=0x%X begin=0x%X end=0x%X cap=0x%X stride=%d",
                        label,
                        off,
                        a,
                        b,
                        c,
                        stride
                    ))

                    summarize_entry_array(
                        a,
                        11,
                        stride,
                        label .. string.format("+0x%X/VECTOR11", off)
                    )
                end
            end
        end
    end

    log(string.format(
        "OBJECT_SUMMARY label=%s candidates=%d",
        label,
        candidates
    ))

    return candidates
end

local base = cfb.module_base()

local roots = {
    {
        name = "PLAY_MANAGER",
        rva = 0x0E19A908
    },
    {
        name = "SIDE_ROOT",
        rva = 0x0F7265F0
    },
    {
        name = "SITUATION_ROOT",
        rva = 0x0F7261F8
    }
}

log(string.format(
    "BEGIN base=0x%X expected_live_players=11",
    base
))

local total_candidates = 0
local child_seen = {}
local child_count = 0
local max_children = 48

for _, root in ipairs(roots) do
    local slot = base + root.rva
    local obj = read_u64(slot)

    log(string.format(
        "ROOT name=%s slot=0x%X value=%s",
        root.name,
        slot,
        obj and string.format("0x%X", obj) or "unreadable"
    ))

    if obj ~= nil and is_probable_ptr(obj) then
        total_candidates = total_candidates
            + inspect_object(root.name, obj, 0x300)

        -- One pointer layer only. Inspect unique readable child objects found
        -- within the first 0x180 bytes of each root object.
        for off = 0, 0x180, 8 do
            if child_count >= max_children then
                break
            end

            local child = read_u64(obj + off)

            if is_probable_ptr(child) and readable_qword(child) then
                local key = string.format("%X", child)

                if not child_seen[key] then
                    child_seen[key] = true
                    child_count = child_count + 1

                    total_candidates = total_candidates
                        + inspect_object(
                            root.name .. string.format(".child+0x%X", off),
                            child,
                            0x100
                        )
                end
            end
        end
    end
end

log(string.format(
    "SUMMARY child_objects=%d total_candidates=%d",
    child_count,
    total_candidates
))

log("END")
