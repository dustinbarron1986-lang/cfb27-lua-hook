local TAG = "[side-actor-fingerprint]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function safe_u8(addr)
    local ok, value = pcall(cfb.read_u8, addr)
    if not ok then return nil end
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
    return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
end

local function read_u64(addr)
    local value = 0
    for i = 7, 0, -1 do
        local b = safe_u8(addr + i)
        if b == nil then return nil end
        value = (value << 8) | b
    end
    return value
end

local function is_probable_ptr(v)
    return v ~= nil
        and v >= 0x10000
        and v < 0x0000800000000000
        and v ~= 0xFFFFFFFF
        and v ~= 0xFFFFFFFFFFFFFFFF
end

local function readable_qword(addr)
    return is_probable_ptr(addr) and read_u64(addr) ~= nil
end

local base = cfb.module_base()

-- PE image size from Optional Header SizeOfImage.
local pe_off = read_u32(base + 0x3C)
if pe_off == nil then
    error("unable to read PE header")
end

local pe = base + pe_off
local image_size = read_u32(pe + 24 + 56)

if image_size == nil then
    error("unable to read SizeOfImage")
end

local image_end = base + image_size

local function is_module_ptr(v)
    return v ~= nil and v >= base and v < image_end
end

local SIDE_ROOT_RVA = 0x0F7265F0
local root_slot = base + SIDE_ROOT_RVA
local side_root = read_u64(root_slot)

log(string.format(
    "BEGIN base=0x%X image_end=0x%X root_slot=0x%X side_root=%s",
    base,
    image_end,
    root_slot,
    side_root and string.format("0x%X", side_root) or "unreadable"
))

if side_root == nil or not readable_qword(side_root) then
    error("SIDE_ROOT unavailable")
end

-- Bounded breadth-first traversal.
local queue = {
    { addr = side_root, depth = 0, source = "SIDE_ROOT" }
}
local qi = 1

local seen = {}
local objects = {}
local max_objects = 256
local max_depth = 2

while qi <= #queue and #objects < max_objects do
    local item = queue[qi]
    qi = qi + 1

    local key = string.format("%X", item.addr)

    if not seen[key] and readable_qword(item.addr) then
        seen[key] = true

        local q0 = read_u64(item.addr)
        local q8 = read_u64(item.addr + 8)
        local q10 = read_u64(item.addr + 0x10)
        local q18 = read_u64(item.addr + 0x18)
        local q20 = read_u64(item.addr + 0x20)

        objects[#objects + 1] = {
            addr = item.addr,
            depth = item.depth,
            source = item.source,
            q0 = q0,
            q8 = q8,
            q10 = q10,
            q18 = q18,
            q20 = q20
        }

        if item.depth < max_depth then
            -- Keep traversal narrow: first 0x100 bytes only, qword-aligned.
            for off = 0, 0x100, 8 do
                local child = read_u64(item.addr + off)

                if is_probable_ptr(child)
                    and readable_qword(child)
                then
                    local child_key = string.format("%X", child)

                    if not seen[child_key] and #queue < (max_objects * 2) then
                        queue[#queue + 1] = {
                            addr = child,
                            depth = item.depth + 1,
                            source = string.format(
                                "%s+0x%X",
                                item.source,
                                off
                            )
                        }
                    end
                end
            end
        end
    end
end

log(string.format(
    "TRAVERSAL objects=%d queued=%d max_depth=%d",
    #objects,
    #queue,
    max_depth
))

local groups = {}

for _, obj in ipairs(objects) do
    if is_module_ptr(obj.q0) then
        local key = string.format("%X", obj.q0)

        if groups[key] == nil then
            groups[key] = {
                vtable = obj.q0,
                members = {}
            }
        end

        groups[key].members[#groups[key].members + 1] = obj
    end
end

local interesting = {}

for _, group in pairs(groups) do
    local n = #group.members

    if n >= 8 and n <= 16 then
        interesting[#interesting + 1] = group
    end
end

table.sort(interesting, function(a, b)
    local da = math.abs(#a.members - 11)
    local db = math.abs(#b.members - 11)

    if da ~= db then
        return da < db
    end

    return a.vtable < b.vtable
end)

log(string.format(
    "GROUP_SUMMARY total_vtable_groups=%d interesting_groups=%d",
    (function()
        local n = 0
        for _ in pairs(groups) do n = n + 1 end
        return n
    end)(),
    #interesting
))

for gi, group in ipairs(interesting) do
    log(string.format(
        "GROUP index=%d vtable=0x%X count=%d exact11=%s",
        gi,
        group.vtable,
        #group.members,
        tostring(#group.members == 11)
    ))

    for mi, obj in ipairs(group.members) do
        log(string.format(
            "MEMBER group=%d member=%d addr=0x%X depth=%d source=%s q0=0x%X q8=%s q10=%s q18=%s q20=%s",
            gi,
            mi,
            obj.addr,
            obj.depth,
            obj.source,
            obj.q0 or 0,
            obj.q8 and string.format("0x%X", obj.q8) or "nil",
            obj.q10 and string.format("0x%X", obj.q10) or "nil",
            obj.q18 and string.format("0x%X", obj.q18) or "nil",
            obj.q20 and string.format("0x%X", obj.q20) or "nil"
        ))
    end
end

-- Also report the largest groups even if they fall outside 8..16, but keep it short.
local all_groups = {}
for _, group in pairs(groups) do
    all_groups[#all_groups + 1] = group
end

table.sort(all_groups, function(a, b)
    if #a.members ~= #b.members then
        return #a.members > #b.members
    end
    return a.vtable < b.vtable
end)

for i = 1, math.min(6, #all_groups) do
    local g = all_groups[i]

    log(string.format(
        "TOP_GROUP rank=%d vtable=0x%X count=%d",
        i,
        g.vtable,
        #g.members
    ))
end

log("END")
